import { describe, expect, it } from 'vitest';

import { EventBus } from '@/engine/events/EventBus';
import type { InputManager } from '@/input/InputManager';
import { isInsideSolid, moveBody, type SolidWorld } from '@/physics/AABB';
import { createVec3 } from '@/physics/Vec3';
import { raycastVoxels, type VoxelBlockSource } from '@/physics/VoxelRaycast';
import {
  FIXED_TIME_STEP,
  PlayerController,
  type PlayerInputSource,
  type PlayerWorld,
} from '@/player/PlayerController';
import type { BiomeId, ChunkDataTarget, TerrainGenerator } from '@/terrain/types';
import { BlockId } from '@/world/BlockRegistry';
import { World } from '@/world/World';

/**
 * 编译期契约检查。
 *
 * I. 为什么这些断言属于测试
 *
 * 1. 物理层与玩家层刻意只依赖**结构接口**（`SolidWorld` / `VoxelBlockSource` /
 *    `PlayerWorld` / `PlayerInputSource`），好处是测试可以传入手写假世界，不必
 *    构造地形生成器或 DOM。
 * 2. 代价是"实现方是否仍然满足接口"不会在使用处被发现。下面几行把赋值关系固定
 *    在编译期：`World` 或 `InputManager` 的签名一旦漂移，`tsc` 立刻失败，等于给
 *    冻结契约加了一把锁。
 */
type Assignable<From, To> = From extends To ? true : false;
type Expect<T extends true> = T;

export type WorldSatisfiesSolidWorld = Expect<Assignable<World, SolidWorld>>;
export type WorldSatisfiesBlockSource = Expect<Assignable<World, VoxelBlockSource>>;
export type WorldSatisfiesPlayerWorld = Expect<Assignable<World, PlayerWorld>>;
export type InputManagerSatisfiesPlayerInput = Expect<Assignable<InputManager, PlayerInputSource>>;

/**
 * 极简测试地形：只在 `height` 层铺一层草方块，其余为空气。
 *
 * I. 两点注意
 *
 * 1. 这里刻意不使用 `src/terrain/**` 的实现：物理与玩家层的验证必须独立于地形
 *    模块的进度，地平线由测试自己定义。
 * 2. 不要往 `y < 0` 写方块：`World.generateChunkNow` 的写入目标直接以
 *    `indexInChunk` 访问 `Uint8Array`，负下标会被静默丢弃；而 `World.getBlock`
 *    对 `y < 0` 恒返回基岩，所以测试里的地平线就是 `height + 1`。
 */
function createFlatGenerator(height = 0): TerrainGenerator {
  return {
    seed: 1,
    options: {
      seaLevel: 62,
      baseHeight: 68,
      mountainAmplitude: 32,
      caves: false,
      ores: false,
      decorations: false,
    },
    generate(_cx: number, _cz: number, target: ChunkDataTarget): void {
      for (let lx = 0; lx < 16; lx += 1) {
        for (let lz = 0; lz < 16; lz += 1) {
          target.setBlock(lx, height, lz, BlockId.Grass);
        }
      }
    },
    surfaceHeightAt(): number {
      return height + 1;
    },
    biomeAt(): BiomeId {
      return 'plains';
    },
  };
}

/** 只向前走的输入源：证明结构接口可以在不接触 DOM 的情况下被满足。 */
function forwardInput(): PlayerInputSource {
  return {
    moveIntent: () => ({
      forward: true,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      sneak: false,
    }),
    consumeLookDelta: () => ({ dx: 0, dy: 0 }),
    wasActionPressed: () => false,
  };
}

function createWorld(): World {
  const world = new World({ seed: 42, generator: createFlatGenerator(0) });
  // 覆盖正负两侧的区块：cx / cz ∈ [-2, 1]。
  for (let cx = -2; cx <= 1; cx += 1) {
    for (let cz = -1; cz <= 1; cz += 1) {
      world.generateChunkNow(cx, cz);
    }
  }
  return world;
}

describe('physics 与真实 World 的集成', () => {
  it('射线在负坐标区块中命中地表，法线朝上', () => {
    const world = createWorld();
    const hit = raycastVoxels(world, createVec3(-8.5, 3.5, -8.5), createVec3(0, -1, 0), 5);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([-9, 0, -9]);
    expect(hit.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(hit.distance).toBeCloseTo(2.5, 10);
  });

  it('射线穿过未加载区块时判为未命中（World 语义：未加载即空气）', () => {
    const world = new World({ seed: 42, generator: createFlatGenerator(0) });
    world.generateChunkNow(0, 0);

    const hit = raycastVoxels(world, createVec3(8.5, 1.5, 8.5), createVec3(1, 0, 0), 32);
    expect(hit.hit).toBe(false);
  });

  it('玩家从空中落到真实世界地表后保持稳定，且始终不在方块内', () => {
    const world = createWorld();
    const controller = new PlayerController({ world, spawn: createVec3(8.5, 4, 8.5) });

    for (let step = 0; step < 120; step += 1) {
      controller.update(FIXED_TIME_STEP);
      expect(isInsideSolid(world, controller.player.body)).toBe(false);
    }

    expect(controller.player.position.y).toBe(1);
    expect(controller.onGround).toBe(true);
    expect(controller.currentChunk).toEqual({ cx: 0, cz: 0 });
  });

  it('玩家跨过区块边界时发出 player:chunk-changed', () => {
    const world = createWorld();
    const events = new EventBus();
    const visited: number[] = [];
    events.on('player:chunk-changed', (payload) => {
      visited.push(payload.cx);
    });

    const controller = new PlayerController({
      world,
      input: forwardInput(),
      events,
      spawn: createVec3(-17.5, 1, 8.5),
    });
    // 面向 +X：从 cx = -2（x ∈ [-32, -17]）走到 cx = -1（x ∈ [-16, -1]）。
    controller.cameraRig.setPose(-Math.PI / 2, 0);

    for (let step = 0; step < 120; step += 1) {
      controller.update(FIXED_TIME_STEP);
    }

    expect(visited).toEqual([-1]);
    expect(controller.currentChunk).toEqual({ cx: -1, cz: 0 });
    expect(controller.player.position.y).toBe(1);
  });

  it('真实世界地表上不会产生垂直抖动', () => {
    const world = createWorld();
    const body = { position: createVec3(2.5, 1, 2.5), halfWidth: 0.3, height: 1.8 };

    for (let step = 0; step < 120; step += 1) {
      const result = moveBody(world, body, createVec3(0, -0.0089, 0));
      expect(result.position.y).toBe(1);
      expect(result.onGround).toBe(true);
    }
  });
});
