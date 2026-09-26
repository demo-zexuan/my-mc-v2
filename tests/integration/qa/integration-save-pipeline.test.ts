import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { INVENTORY_SLOTS, MAX_STACK_SIZE, type ItemStack } from '@/inventory/types';
import { SaveManager } from '@/save/SaveManager';
import type { SaveWorldInput } from '@/save/saveSchema';
import { DEFAULT_SETTINGS } from '@/settings/types';
import { createTerrainGenerator } from '@/terrain';
import { BlockId } from '@/world/BlockRegistry';
import { World } from '@/world/World';
import type { Chunk } from '@/world/Chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '@/world/coords';

/**
 * 存档往返集成测试（T7 QA 追加范围）。
 *
 * I. 这条链路此前完全没有覆盖
 *
 * `tests/unit/save/**` 覆盖了 schema 迁移、节流和 IndexedDB 存储本身，但**没有任何测试
 * 把"真实地形 + World 编辑 + SaveManager + 重新生成世界"串起来**。而验收标准里"挖掉的
 * 方块读档后仍然是空气"恰好落在这条缝隙上：
 *
 * 1. `World` 只保存被修改过的区块（`chunk.getEdits()`），未修改的靠种子重新生成；
 * 2. 重新进入世界时，生成器必须**逐字节**重现原来的地形，否则回放编辑会得到不同的世界；
 * 3. `edit.index` 是区块内扁平下标，回放正确性同时依赖坐标布局与高度图重算。
 *
 * 因此这里不使用平坦测试生成器，而是用**真实生产生成器**（含洞穴、矿脉、树木、水），
 * 走真正的 IndexedDB 事务路径，最后断言"读档后的世界与保存前逐字节一致"。
 *
 * II. 与 `WorldSession.buildSaveInput()` 的关系
 *
 * 入参的组装逻辑与 `WorldSession.buildSaveInput()` 保持一致（同样的字段、同样只收集
 * `editedChunks()`）。WorldSession 本身需要 WebGL 与 DOM，无法在 Node 里实例化，因此
 * 这里复刻它的组装规则；e2e 侧另有"保存并退出 → 开始游戏恢复玩家位置"的用例覆盖
 * 真实组装路径。
 */

const SEED = 20_250_926;

/** 每个用例一个世界 id，避免 fake-indexeddb 在进程内共享数据。 */
let worldCounter = 0;
function nextWorldId(): string {
  worldCounter += 1;
  return `qa-pipeline-${worldCounter}`;
}

/** 生成一个 3x3 区块的世界。 */
function createPopulatedWorld(seed = SEED): World {
  const generator = createTerrainGenerator(seed, { decorations: true, caves: true, ores: true });
  const world = new World({ seed, generator, maxLoadedChunks: 64 });
  for (let cz = -1; cz <= 1; cz += 1) {
    for (let cx = -1; cx <= 1; cx += 1) {
      world.generateChunkNow(cx, cz);
    }
  }
  return world;
}

/** 按 `WorldSession.buildSaveInput()` 的规则组装入参。 */
function buildInput(world: World, id: string, name: string, seed = SEED): SaveWorldInput {
  const chunks: { cx: number; cz: number; edits: readonly { index: number; id: BlockId }[] }[] = [];
  for (const chunk of world.editedChunks()) {
    chunks.push({ cx: chunk.cx, cz: chunk.cz, edits: chunk.getEdits() });
  }

  const slots: (ItemStack | null)[] = new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
  slots[0] = { item: BlockId.Dirt, count: 3 };
  slots[9] = { item: BlockId.Stone, count: MAX_STACK_SIZE };

  return {
    id,
    name,
    seed,
    gameTime: 12_345,
    player: {
      position: { x: 4.5, y: 71.25, z: -3.5 },
      rotation: { yaw: 0.75, pitch: -0.2 },
      velocity: { x: 0, y: 0, z: 0 },
      health: 20,
      inventory: { slots, selected: 1 },
    },
    settings: { ...DEFAULT_SETTINGS },
    chunks,
  };
}

/** 找到一列地表，返回可以安全挖掉的地表方块坐标。 */
function findSurfaceBlock(
  world: World,
  x: number,
  z: number,
): { readonly x: number; readonly y: number; readonly z: number } {
  for (let y = 127; y >= 0; y -= 1) {
    const id = world.getBlock(x, y, z);
    if (id !== BlockId.Air && id !== BlockId.Water) {
      return { x, y, z };
    }
  }
  throw new Error(`column (${x},${z}) is empty`);
}

/** 快照 3x3 区域的全部字节，用于逐字节比较。 */
function snapshot(world: World): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const chunk of world.chunks) {
    map.set(`${chunk.cx},${chunk.cz}`, Uint8Array.from(chunk.blocks));
  }
  return map;
}

/** 读档：新建世界 → 重新生成同样的区块 → 回放存档里的编辑。 */
function reload(
  worldId: string,
  seed: number,
  chunks: readonly {
    readonly cx: number;
    readonly cz: number;
    readonly edits: readonly { readonly index: number; readonly id: BlockId }[];
  }[],
): World {
  const world = createPopulatedWorld(seed);
  expect(worldId.length).toBeGreaterThan(0);
  for (const saved of chunks) {
    const chunk: Chunk | undefined = world.getChunk(saved.cx, saved.cz);
    expect(chunk, `读档时区块 (${saved.cx},${saved.cz}) 不存在`).toBeDefined();
    chunk?.applyEdits(saved.edits);
  }
  return world;
}

describe('存档往返：真实地形 + 编辑 + IndexedDB', () => {
  it('挖掉的方块读档后仍然是空气，且世界逐字节一致', async () => {
    const worldId = nextWorldId();
    const save = new SaveManager();

    const world = createPopulatedWorld();
    // I. 挖一个跨区块的洞，再盖一座塔，覆盖"减少"与"增加"两种编辑。
    const dug: { readonly x: number; readonly y: number; readonly z: number }[] = [];
    for (const [x, z] of [
      [0, 0],
      [15, 15],
      [-1, -1],
      [-16, 3],
    ] as const) {
      const block = findSurfaceBlock(world, x, z);
      expect(
        world.setBlock(block.x, block.y, block.z, BlockId.Air),
        `挖掉 (${x},${block.y},${z})`,
      ).toBe(true);
      dug.push(block);
    }
    expect(world.setBlock(3, 90, 3, BlockId.Lamp)).toBe(true);
    expect(world.setBlock(3, 91, 3, BlockId.Glass)).toBe(true);

    const before = snapshot(world);
    const input = buildInput(world, worldId, 'QA 往返世界');
    expect(input.chunks.length, '只应保存被修改过的区块').toBeGreaterThan(0);
    expect(input.chunks.length).toBeLessThanOrEqual(9);

    await save.saveWorld(input);
    expect(await save.hasWorld(worldId)).toBe(true);

    // II. 读档并重建世界。
    const loaded = await save.loadWorld(worldId);
    expect(loaded.seed).toBe(SEED);
    expect(loaded.player.position).toEqual({ x: 4.5, y: 71.25, z: -3.5 });
    expect(loaded.player.inventory.slots[9]).toEqual({
      item: BlockId.Stone,
      count: MAX_STACK_SIZE,
    });
    expect(loaded.chunks.length).toBe(input.chunks.length);

    const restored = reload(loaded.worldId, SEED, loaded.chunks);

    // III. 被挖的方块必须仍然是空气 —— 这是整个验收标准的核心断言。
    for (const block of dug) {
      expect(
        restored.getBlock(block.x, block.y, block.z),
        `读档后 (${block.x},${block.y},${block.z})`,
      ).toBe(BlockId.Air);
    }
    expect(restored.getBlock(3, 90, 3)).toBe(BlockId.Lamp);
    expect(restored.getBlock(3, 91, 3)).toBe(BlockId.Glass);

    // IV. 逐字节一致：任何差异都意味着"读档后的世界和保存前不是同一个世界"。
    const after = snapshot(restored);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, bytes] of before) {
      expect(after.get(key), `区块 ${key} 的字节不一致`).toEqual(bytes);
    }

    // V. 高度图也必须一致，否则读档后还会出现"看不见的实心方块"。
    for (const chunk of world.chunks) {
      const restoredChunk = restored.getChunk(chunk.cx, chunk.cz);
      expect(restoredChunk?.heightMap, `区块 (${chunk.cx},${chunk.cz}) 高度图`).toEqual(
        chunk.heightMap,
      );
      expect(restoredChunk?.highestNonAir).toBe(chunk.highestNonAir);
    }

    save.dispose();
  });

  it('未修改的区块不进存档，重新进入时靠种子重建', async () => {
    const worldId = nextWorldId();
    const save = new SaveManager();

    const world = createPopulatedWorld();
    // 只在 (0,0) 里动一个方块。
    const block = findSurfaceBlock(world, 4, 4);
    expect(world.setBlock(block.x, block.y, block.z, BlockId.Air)).toBe(true);

    await save.saveWorld(buildInput(world, worldId, '单区块编辑'));
    const loaded = await save.loadWorld(worldId);

    // 9 个区块里只有 1 个被修改 → 存档里只应出现 1 条区块记录。
    expect(loaded.chunks).toHaveLength(1);
    expect(loaded.chunks[0]?.cx).toBe(0);
    expect(loaded.chunks[0]?.cz).toBe(0);

    // 其余 8 个区块靠生成器重建，并且必须和原来的内容完全一致。
    const restored = reload(loaded.worldId, SEED, loaded.chunks);
    for (const chunk of world.chunks) {
      const other = restored.getChunk(chunk.cx, chunk.cz);
      if (chunk.cx === 0 && chunk.cz === 0) {
        continue;
      }
      expect(other?.blocks, `未修改区块 (${chunk.cx},${chunk.cz}) 应由种子重建`).toEqual(
        chunk.blocks,
      );
    }

    save.dispose();
  });

  it('两次读档得到同一个世界（生成器确定性 + 编辑可重放）', async () => {
    const worldId = nextWorldId();
    const save = new SaveManager();

    const world = createPopulatedWorld();
    for (let i = 0; i < 20; i += 1) {
      const x = (i % 16) - 8;
      const z = ((i * 7) % 16) - 8;
      const block = findSurfaceBlock(world, x, z);
      world.setBlock(block.x, block.y, block.z, BlockId.Air);
      world.setBlock(block.x, block.y + 1, block.z, BlockId.Planks);
    }

    await save.saveWorld(buildInput(world, worldId, '确定性世界'));
    const loaded = await save.loadWorld(worldId);

    const first = reload(loaded.worldId, SEED, loaded.chunks);
    const second = reload(loaded.worldId, SEED, loaded.chunks);

    for (const chunk of first.chunks) {
      const twin = second.getChunk(chunk.cx, chunk.cz);
      expect(twin?.blocks, `两次读档的区块 (${chunk.cx},${chunk.cz})`).toEqual(chunk.blocks);
    }

    save.dispose();
  });

  it('存档里记录的编辑下标与区块布局一致（回放后能按世界坐标读到）', async () => {
    const worldId = nextWorldId();
    const save = new SaveManager();

    const world = createPopulatedWorld();
    // 在区块边界的两侧各放一个方块：下标算错时这两个位置最容易错位。
    expect(world.setBlock(15, 80, 15, BlockId.Brick)).toBe(true);
    expect(world.setBlock(-16, 80, 0, BlockId.Brick)).toBe(true);
    expect(world.setBlock(0, 80, -16, BlockId.Brick)).toBe(true);

    await save.saveWorld(buildInput(world, worldId, '边界编辑'));
    const loaded = await save.loadWorld(worldId);

    // 编辑下标必须落在 [0, CHUNK_VOLUME) 内且为整数，否则回放会静默丢弃。
    for (const chunk of loaded.chunks) {
      for (const edit of chunk.edits) {
        expect(
          Number.isInteger(edit.index),
          `区块 (${chunk.cx},${chunk.cz}) 的下标 ${edit.index}`,
        ).toBe(true);
        expect(edit.index).toBeGreaterThanOrEqual(0);
        expect(edit.index).toBeLessThan(CHUNK_SIZE_X * 128 * CHUNK_SIZE_Z);
      }
    }

    const restored = reload(loaded.worldId, SEED, loaded.chunks);
    expect(restored.getBlock(15, 80, 15)).toBe(BlockId.Brick);
    expect(restored.getBlock(-16, 80, 0)).toBe(BlockId.Brick);
    expect(restored.getBlock(0, 80, -16)).toBe(BlockId.Brick);

    save.dispose();
  });

  it('世界列表包含刚保存的世界，删除后消失', async () => {
    const worldId = nextWorldId();
    const save = new SaveManager();
    const world = createPopulatedWorld();

    await save.saveWorld(buildInput(world, worldId, '列表世界'));
    const listed = await save.listWorlds();
    expect(listed.some((entry) => entry.id === worldId)).toBe(true);

    await save.deleteWorld(worldId);
    expect(await save.hasWorld(worldId)).toBe(false);
    const afterDelete = await save.listWorlds();
    expect(afterDelete.some((entry) => entry.id === worldId)).toBe(false);

    save.dispose();
  });
});
