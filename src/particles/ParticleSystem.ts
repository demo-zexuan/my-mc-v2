/**
 * 方块破坏/放置粒子。
 *
 * I. 为什么用定长对象池 + Float32Array 而不是数组里的对象
 *
 * 1. 粒子是本作中唯一"每帧大批量生灭"的对象。如果每个粒子是一个 `{position, velocity}`
 *    对象，一次挖掘就产生十几个短命对象，一片矿洞连续挖掘会稳定地给 GC 施压，
 *    而 GC 造成的掉帧恰好出现在玩家最投入的时候。
 * 2. 结构数组（SoA）把位置/速度/寿命放在连续的 `Float32Array` 里，
 *    遍历时是顺序内存访问，且**运行期一次分配都不需要**：
 *    整个系统的内存占用在构造时就确定了。
 *
 * II. 为什么池满时覆盖最旧的粒子而不是拒绝新粒子
 *
 * 拒绝新粒子会让"连续挖穿一片石头"的后半段完全没有反馈；覆盖轮转指针指向的粒子
 * 保证任何时刻都有**恰好** `capacity` 个位置可用，视觉上表现为最老的粒子提前消失，
 * 这与人眼对碎屑的感知一致。无论哪种策略，活性上限都恒为 `capacity`，
 * 系统不可能无限增长。
 *
 * III. 随机数为什么是自带种子的 PRNG
 *
 * 粒子是纯表现层，不需要密码学随机。自带种子的 mulberry32 让同样的输入产生
 * 同样的粒子轨迹，视觉回归截图与单元测试都能复现。
 *
 * @module particles/ParticleSystem
 */

import * as THREE from 'three';

import type { EventBus, Unsubscribe } from '@/engine/events/EventBus';
import { blockColorOf } from '@/inventory/ItemRegistry';
import type { Vec3Like } from '@/interaction/types';
import type { BlockId } from '@/world/BlockRegistry';

/** 默认粒子容量。 */
export const DEFAULT_PARTICLE_CAPACITY = 512;

/** 破坏方块时的默认粒子数。 */
export const DEFAULT_BREAK_PARTICLES = 12;

/** 放置方块时的默认粒子数。 */
export const DEFAULT_PLACE_PARTICLES = 6;

/** 粒子重力（方块/秒²）。 */
const PARTICLE_GRAVITY = 20;

/** 粒子寿命范围（秒）。 */
const MIN_LIFETIME = 0.35;
const MAX_LIFETIME = 0.9;

/** 粒子边长范围（方块）。 */
const MIN_SIZE = 0.05;
const MAX_SIZE = 0.12;

/** 一次爆发的参数。 */
export interface ParticleBurstOptions {
  /** 粒子数。 */
  readonly count: number;
  /** 颜色，`0xRRGGBB`。 */
  readonly color: number;
  /** 初速度大小（方块/秒）。 */
  readonly speed?: number;
  /** 粒子出生位置的随机散布半径（方块）。 */
  readonly spread?: number;
  /** 速度的向上偏置，越大越像"被炸起来"。 */
  readonly lift?: number;
}

/** 构造参数。 */
export interface ParticleSystemOptions {
  /** 事件总线；提供时自动订阅 `block:broken` / `block:placed`。 */
  readonly bus?: EventBus;
  /** 父节点；提供时渲染对象会被自动挂上。 */
  readonly parent?: THREE.Object3D;
  /** 池容量，默认 512。 */
  readonly capacity?: number;
  /** PRNG 种子，默认 1；仅影响表现，不影响游戏逻辑。 */
  readonly seed?: number;
}

export class ParticleSystem {
  readonly #capacity: number;

  // I. 粒子状态（SoA）。
  readonly #px: Float32Array;
  readonly #py: Float32Array;
  readonly #pz: Float32Array;
  readonly #vx: Float32Array;
  readonly #vy: Float32Array;
  readonly #vz: Float32Array;
  readonly #life: Float32Array;
  readonly #maxLife: Float32Array;
  readonly #size: Float32Array;
  readonly #colorHex: Float32Array;

  // II. 空闲槽位栈。
  readonly #freeList: Int32Array;
  #freeCount: number;
  #activeCount = 0;
  #overflowCursor = 0;
  #spawnedTotal = 0;

  // III. 渲染资源：几何体与材质全系统共享一份。
  readonly #geometry: THREE.BoxGeometry;
  readonly #material: THREE.MeshBasicMaterial;
  readonly #mesh: THREE.InstancedMesh;

  // IV. 复用的临时对象。
  readonly #matrix = new THREE.Matrix4();
  readonly #position = new THREE.Vector3();
  readonly #scale = new THREE.Vector3(1, 1, 1);
  readonly #quaternion = new THREE.Quaternion();
  readonly #color = new THREE.Color();

  #rngState: number;
  #unsubscribes: Unsubscribe[] = [];

  public constructor(options: ParticleSystemOptions = {}) {
    const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_PARTICLE_CAPACITY));
    this.#capacity = capacity;

    this.#px = new Float32Array(capacity);
    this.#py = new Float32Array(capacity);
    this.#pz = new Float32Array(capacity);
    this.#vx = new Float32Array(capacity);
    this.#vy = new Float32Array(capacity);
    this.#vz = new Float32Array(capacity);
    this.#life = new Float32Array(capacity);
    this.#maxLife = new Float32Array(capacity);
    this.#size = new Float32Array(capacity);
    this.#colorHex = new Float32Array(capacity);

    // 初始时全部空闲：栈顶在末尾，逐个弹出即是 0..capacity-1。
    this.#freeList = new Int32Array(capacity);
    for (let i = 0; i < capacity; i += 1) {
      this.#freeList[i] = i;
    }
    this.#freeCount = capacity;

    this.#rngState = Math.floor(options.seed ?? 1) | 0 || 1;

    this.#geometry = new THREE.BoxGeometry(1, 1, 1);
    this.#material = new THREE.MeshBasicMaterial();
    this.#mesh = new THREE.InstancedMesh(this.#geometry, this.#material, capacity);
    this.#mesh.name = 'block-particles';
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.frustumCulled = false;
    this.#mesh.count = 0;
    this.#mesh.setColorAt(0, this.#color.setHex(0xffffff));

    if (options.parent !== undefined) {
      options.parent.add(this.#mesh);
    }

    const bus = options.bus;
    if (bus !== undefined) {
      this.#unsubscribes = [
        bus.on('block:broken', (payload) => {
          this.emitBlockBreak(payload.x, payload.y, payload.z, payload.block);
        }),
        bus.on('block:placed', (payload) => {
          this.emitBlockPlaced(payload.x, payload.y, payload.z, payload.block);
        }),
      ];
    }
  }

  /** 池容量（恒定不变）。 */
  public get capacity(): number {
    return this.#capacity;
  }

  /** 当前活跃粒子数，永远 `<= capacity`。 */
  public get activeCount(): number {
    return this.#activeCount;
  }

  /** 累计生成过的粒子数（用于确认池没有被"扩容"）。 */
  public get spawnedTotal(): number {
    return this.#spawnedTotal;
  }

  /** 挂到场景里的对象。 */
  public get object3d(): THREE.Object3D {
    return this.#mesh;
  }

  /** 共享几何体。 */
  public get geometry(): THREE.BoxGeometry {
    return this.#geometry;
  }

  /** 共享材质。 */
  public get material(): THREE.MeshBasicMaterial {
    return this.#material;
  }

  /**
   * 在指定位置爆发一簇粒子。
   *
   * @param position - 爆发中心（世界坐标）。
   * @param options - 数量、颜色与手感参数。
   * @returns 实际生成的粒子数（等于 `count`，池满时覆盖旧粒子而不是丢弃）。
   */
  public burst(position: Vec3Like, options: ParticleBurstOptions): number {
    const count = Math.floor(options.count);
    if (!Number.isFinite(count) || count <= 0) {
      return 0;
    }
    const speed = options.speed ?? 3.2;
    const spread = options.spread ?? 0.35;
    const lift = options.lift ?? 0.5;

    let spawned = 0;
    for (let n = 0; n < count; n += 1) {
      const index = this.#acquire();
      this.#spawnAt(index, position, options.color, speed, spread, lift);
      spawned += 1;
    }
    return spawned;
  }

  /**
   * 破坏方块的粒子：以方块主色为准，从方块中心向四周飞散。
   *
   * @param x - 方块整数 X。
   * @param y - 方块整数 Y。
   * @param z - 方块整数 Z。
   * @param block - 被破坏的方块 id。
   * @param count - 粒子数，默认 12。
   */
  public emitBlockBreak(
    x: number,
    y: number,
    z: number,
    block: BlockId,
    count: number = DEFAULT_BREAK_PARTICLES,
  ): number {
    return this.burst(
      { x: x + 0.5, y: y + 0.5, z: z + 0.5 },
      { count, color: blockColorOf(block), speed: 3.4, spread: 0.45, lift: 0.55 },
    );
  }

  /**
   * 放置方块的粒子：数量与速度都更小，像被按压挤出的碎屑。
   *
   * @param x - 方块整数 X。
   * @param y - 方块整数 Y。
   * @param z - 方块整数 Z。
   * @param block - 被放置的方块 id。
   * @param count - 粒子数，默认 6。
   */
  public emitBlockPlaced(
    x: number,
    y: number,
    z: number,
    block: BlockId,
    count: number = DEFAULT_PLACE_PARTICLES,
  ): number {
    return this.burst(
      { x: x + 0.5, y: y + 0.5, z: z + 0.5 },
      { count, color: blockColorOf(block), speed: 1.6, spread: 0.5, lift: 0.7 },
    );
  }

  /**
   * 推进一帧。
   *
   * I. 为什么遍历整个容量而不是只遍历活跃槽位
   *
   * 容量上限只有几百，一次顺序遍历 `Float32Array` 的成本远低于维护一个活跃索引列表；
   * 而且**没有分支预测失败的链表跳转**。稳定、可预测比追求理论最小值更重要。
   *
   * @param deltaSeconds - 距上一帧的秒数。
   */
  public update(deltaSeconds: number): void {
    const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    let visible = 0;

    for (let i = 0; i < this.#capacity; i += 1) {
      const life = this.#life[i] ?? 0;
      if (life <= 0) {
        continue;
      }

      const remaining = life - dt;
      if (remaining <= 0) {
        this.#release(i);
        continue;
      }
      this.#life[i] = remaining;

      const vy = (this.#vy[i] ?? 0) - PARTICLE_GRAVITY * dt;
      this.#vy[i] = vy;
      this.#px[i] = (this.#px[i] ?? 0) + (this.#vx[i] ?? 0) * dt;
      this.#py[i] = (this.#py[i] ?? 0) + vy * dt;
      this.#pz[i] = (this.#pz[i] ?? 0) + (this.#vz[i] ?? 0) * dt;

      const size = this.#size[i] ?? MIN_SIZE;
      // 用剩余寿命收缩粒子：不需要逐实例 alpha（共享材质无法表达），
      // 但视觉上同样读得出"正在消失"。
      const maxLife = this.#maxLife[i] ?? 1;
      const fade = maxLife > 0 ? Math.max(0.35, remaining / maxLife) : 1;
      this.#position.set(this.#px[i] ?? 0, this.#py[i] ?? 0, this.#pz[i] ?? 0);
      this.#scale.setScalar(size * fade);
      this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
      this.#mesh.setMatrixAt(visible, this.#matrix);
      this.#mesh.setColorAt(visible, this.#color.setHex(this.#colorHex[i] ?? 0xffffff));
      visible += 1;
    }

    this.#mesh.count = visible;
    this.#mesh.instanceMatrix.needsUpdate = true;
    if (this.#mesh.instanceColor !== null) {
      this.#mesh.instanceColor.needsUpdate = true;
    }
  }

  /** 清空所有活跃粒子并归还槽位。 */
  public clear(): void {
    for (let i = 0; i < this.#capacity; i += 1) {
      if ((this.#life[i] ?? 0) > 0) {
        this.#release(i);
      }
    }
    this.#mesh.count = 0;
    this.#mesh.instanceMatrix.needsUpdate = true;
  }

  /** 取消事件订阅、从父节点移除并释放 GPU 资源。 */
  public dispose(): void {
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe();
    }
    this.#unsubscribes = [];
    this.clear();
    this.#mesh.removeFromParent();
    this.#mesh.dispose();
    this.#geometry.dispose();
    this.#material.dispose();
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 取一个可用槽位：优先空闲栈，栈空则覆盖轮转指针处的粒子。 */
  #acquire(): number {
    if (this.#freeCount > 0) {
      this.#freeCount -= 1;
      this.#activeCount += 1;
      return this.#freeList[this.#freeCount] ?? 0;
    }
    const index = this.#overflowCursor;
    this.#overflowCursor = (this.#overflowCursor + 1) % this.#capacity;
    return index;
  }

  /** 归还槽位。 */
  #release(index: number): void {
    if ((this.#life[index] ?? 0) <= 0) {
      return;
    }
    this.#life[index] = 0;
    if (this.#freeCount < this.#capacity) {
      this.#freeList[this.#freeCount] = index;
      this.#freeCount += 1;
    }
    this.#activeCount = Math.max(0, this.#activeCount - 1);
  }

  #spawnAt(
    index: number,
    centre: Vec3Like,
    color: number,
    speed: number,
    spread: number,
    lift: number,
  ): void {
    this.#px[index] = centre.x + (this.#random() - 0.5) * spread * 2;
    this.#py[index] = centre.y + (this.#random() - 0.5) * spread * 2;
    this.#pz[index] = centre.z + (this.#random() - 0.5) * spread * 2;

    // 单位球面采样 + 向上偏置。
    const theta = this.#random() * Math.PI * 2;
    const z = this.#random() * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const magnitude = speed * (0.4 + this.#random() * 0.8);
    this.#vx[index] = Math.cos(theta) * r * magnitude;
    this.#vz[index] = Math.sin(theta) * r * magnitude;
    this.#vy[index] = (z * 0.5 + lift) * magnitude;

    const lifetime = MIN_LIFETIME + this.#random() * (MAX_LIFETIME - MIN_LIFETIME);
    this.#life[index] = lifetime;
    this.#maxLife[index] = lifetime;
    this.#size[index] = MIN_SIZE + this.#random() * (MAX_SIZE - MIN_SIZE);
    this.#colorHex[index] = color;
    this.#spawnedTotal += 1;
  }

  /** mulberry32：32 位状态、无分配、同种子完全可复现。 */
  #random(): number {
    this.#rngState = (this.#rngState + 0x6d2b79f5) | 0;
    let t = this.#rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
