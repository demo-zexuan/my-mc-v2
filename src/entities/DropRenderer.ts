/**
 * 掉落物的实例化渲染。
 *
 * I. 为什么是 InstancedMesh 而不是每个掉落物一个 Mesh
 *
 * 一次挖掘就会产生十几个掉落物，一片树林被烧掉可能产生上百个。
 * 每个掉落物一个 `Mesh` 意味着每个都有自己的 `Object3D` 矩阵、绘制调用与
 * 材质状态切换；`InstancedMesh` 把 N 个立方体压成一次绘制调用，
 * 并且几何体与材质**全场景共享一份**。
 *
 * II. 为什么渲染与 DropSystem 分开
 *
 * `DropSystem` 是纯逻辑（Node 里可测、可复现），`DropRenderer` 只依赖 Three.js。
 * 两者通过 `readonly ItemEntity[]` 单向同步，因此可以在没有 WebGL 的环境里
 * 只测逻辑，也可以在真实场景里只关心矩阵写入。
 *
 * III. 为什么未使用的实例不画，而不是缩放成 0
 *
 * `InstancedMesh.count` 是"实际绘制多少个实例"的开关。把空实例缩放成 0
 * 依然会让它们进入顶点着色器与光栅化阶段（只是没有像素输出），
 * 直接调小 `count` 才是真正的零成本。
 *
 * @module entities/DropRenderer
 */

import * as THREE from 'three';

import { blockColorOf } from '@/inventory/ItemRegistry';

import type { ItemEntity } from './ItemEntity';

/** 默认实例容量。 */
export const DEFAULT_DROP_CAPACITY = 256;

/** 构造参数。 */
export interface DropRendererOptions {
  /** 场景（或任意父节点）；提供时渲染对象会被自动挂上。 */
  readonly parent?: THREE.Object3D;
  /** 实例容量上限，默认 256，与 DropSystem 的实体上限一致。 */
  readonly capacity?: number;
}

export class DropRenderer {
  readonly #geometry: THREE.BoxGeometry;
  readonly #material: THREE.MeshLambertMaterial;
  readonly #mesh: THREE.InstancedMesh;

  // 复用的临时对象：`sync` 每帧都会跑，不能在这里分配。
  readonly #matrix = new THREE.Matrix4();
  readonly #position = new THREE.Vector3();
  readonly #quaternion = new THREE.Quaternion();
  readonly #scale = new THREE.Vector3(1, 1, 1);
  readonly #color = new THREE.Color();
  readonly #up = new THREE.Vector3(0, 1, 0);

  public constructor(options: DropRendererOptions = {}) {
    const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_DROP_CAPACITY));

    // 全场景共享的几何体与材质：这是"禁止每个掉落物新建 Geometry"的落点。
    this.#geometry = new THREE.BoxGeometry(0.25, 0.25, 0.25);
    this.#material = new THREE.MeshLambertMaterial();
    this.#mesh = new THREE.InstancedMesh(this.#geometry, this.#material, capacity);
    this.#mesh.name = 'drop-entities';
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.frustumCulled = false;
    this.#mesh.count = 0;

    // 预先分配 instanceColor，这样 sync 里不需要判断它是否已创建。
    for (let i = 0; i < capacity; i += 1) {
      this.#mesh.setColorAt(i, this.#color.setHex(0xffffff));
    }

    if (options.parent !== undefined) {
      options.parent.add(this.#mesh);
    }
  }

  /** 挂到场景里的对象。 */
  public get object3d(): THREE.Object3D {
    return this.#mesh;
  }

  /** 实例容量。 */
  public get capacity(): number {
    return this.#mesh.instanceMatrix.count;
  }

  /** 当前实际绘制的实例数。 */
  public get instanceCount(): number {
    return this.#mesh.count;
  }

  /** 共享的几何体（测试用于确认没有重复创建）。 */
  public get geometry(): THREE.BoxGeometry {
    return this.#geometry;
  }

  /** 共享的材质。 */
  public get material(): THREE.MeshLambertMaterial {
    return this.#material;
  }

  /**
   * 把实体列表同步到实例矩阵。
   *
   * @param entities - 当前存活实体；超过容量时多余的不绘制。
   * @returns 实际写入的实例数。
   */
  public sync(entities: readonly ItemEntity[]): number {
    const limit = Math.min(entities.length, this.#mesh.instanceMatrix.count);
    let visible = 0;

    for (let i = 0; i < limit; i += 1) {
      const entity = entities[i];
      if (entity === undefined || !entity.alive) {
        continue;
      }

      this.#position.set(
        entity.position.x,
        entity.position.y + entity.bobOffset(),
        entity.position.z,
      );
      this.#quaternion.setFromAxisAngle(this.#up, entity.spinAngle());
      this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
      this.#mesh.setMatrixAt(visible, this.#matrix);
      this.#mesh.setColorAt(visible, this.#color.setHex(blockColorOf(entity.item)));
      visible += 1;
    }

    this.#mesh.count = visible;
    this.#mesh.instanceMatrix.needsUpdate = true;
    if (this.#mesh.instanceColor !== null) {
      this.#mesh.instanceColor.needsUpdate = true;
    }
    return visible;
  }

  /** 从场景移除并释放 GPU 资源。 */
  public dispose(): void {
    this.#mesh.removeFromParent();
    this.#mesh.dispose();
    this.#geometry.dispose();
    this.#material.dispose();
    this.#mesh.count = 0;
  }
}
