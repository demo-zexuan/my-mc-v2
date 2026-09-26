/**
 * 存档数据模型：结构定义、zod 校验与版本迁移。
 *
 * I. 为什么把"结构 + 校验 + 迁移"放在一个文件
 *
 * 1. 存档格式的三件事是同一个不变量的三个面：能写出的结构、能读回的结构、旧结构如何变成
 *    新结构。分开放在三个文件里，最容易出现"迁移产出的字段没被 schema 覆盖"这类漏洞。
 * 2. 迁移是**按版本逐级升级**的：`v1 → v2 → v3 ...`，每一步只关心相邻两个版本。这样
 *    N 个版本只需要 N-1 个小函数，而不是 N 个"从任意旧版本直接升级"的复杂函数。
 *
 * II. 失败语义
 *
 * 1. 结构损坏（不是对象、缺字段、类型不对）→ `AppError('SAVE_CORRUPTED')`。
 * 2. 版本高于当前程序 → `AppError('SAVE_VERSION_UNSUPPORTED')`。这种情况必须与"损坏"
 *    区分：玩家用新版本玩过之后回退版本，提示应该是"请升级游戏"而不是"存档坏了"。
 *
 * III. 只存被修改过的区块
 *
 * 1. 玩家走过的地形可以由种子重新生成，只有被修改过的方块必须落盘。本模块因此只提供
 *    `BlockEdit`（区块内扁平下标 + 方块 id）的序列化，不保存整块 `Uint8Array`。
 * 2. 好处是存档体积与"玩家造了多少东西"相关，而不是与"玩家走了多远"相关。
 *
 * @module save/saveSchema
 */

import { z } from 'zod';

import {
  HOTBAR_SLOTS,
  INVENTORY_SLOTS,
  MAX_STACK_SIZE,
  type InventorySnapshot,
  type ItemStack,
} from '@/inventory/types';
import { normalizeSettings, type GameSettings } from '@/settings/types';
import { AppError } from '@/utils/errors';
import { MAX_BLOCK_ID, type BlockId } from '@/world/BlockRegistry';
import type { BlockEdit } from '@/world/Chunk';
import { CHUNK_VOLUME } from '@/world/coords';

/** 当前存档结构版本；每次结构变更都要 +1 并补一个迁移函数。 */
export const SAVE_SCHEMA_VERSION = 2;

/** 支持读取的最老版本；更老的存档没有迁移路径。 */
export const FIRST_SUPPORTED_SCHEMA_VERSION = 1;

/** 玩家生命上限；存档里的生命值超出范围时按此钳制。 */
export const MAX_HEALTH = 20;

/** 三维向量。 */
export interface Vector3Value {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 视角朝向，弧度制。 */
export interface RotationValue {
  readonly yaw: number;
  readonly pitch: number;
}

/** 存档中的玩家状态。 */
export interface PlayerSaveState {
  readonly position: Vector3Value;
  readonly rotation: RotationValue;
  readonly velocity: Vector3Value;
  readonly health: number;
  readonly inventory: InventorySnapshot;
}

/** 待写入的区块修改。 */
export interface ChunkSaveInput {
  readonly cx: number;
  readonly cz: number;
  readonly edits: readonly BlockEdit[];
}

/** `saveWorld` 的入参。 */
export interface SaveWorldInput {
  /** 世界唯一 id（调用方生成，通常是 UUID）。 */
  readonly id: string;
  readonly name: string;
  readonly seed: number | string;
  readonly gameTime: number;
  readonly player: PlayerSaveState;
  readonly settings: GameSettings;
  /** 只应传入 `chunk.getEdits()` 非空的区块。 */
  readonly chunks: readonly ChunkSaveInput[];
  /** 首次创建时间；存档已存在时由存储层保留原值，这里只作为缺省。 */
  readonly createdAt?: number;
  /** 覆盖更新时间；仅测试需要，正常由 `now()` 提供。 */
  readonly updatedAt?: number;
}

/** v1 内嵌在文档里的区块数据；迁移到 v2 后保留在此字段，首次保存时提升为独立记录。 */
export interface LegacyChunkRecord {
  readonly cx: number;
  readonly cz: number;
  readonly edits: readonly BlockEdit[];
}

/** 当前版本（v2）的存档文档。 */
export interface WorldSaveDocument {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly seed: number | string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly gameTime: number;
  readonly player: PlayerSaveState;
  readonly settings: GameSettings;
  readonly legacyChunks: readonly LegacyChunkRecord[];
}

/** 世界列表条目；不包含区块数据。 */
export interface WorldSummary {
  readonly id: string;
  readonly name: string;
  readonly seed: number | string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly gameTime: number;
}

// ---------------------------------------------------------------------------
// zod 结构
// ---------------------------------------------------------------------------

type RawDocument = Record<string, unknown>;

function isRecord(value: unknown): value is RawDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function corrupted(message: string, cause?: unknown): AppError {
  return new AppError('SAVE_CORRUPTED', message, cause === undefined ? {} : { cause });
}

const vectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

const rotationSchema = z.object({
  yaw: z.number().finite(),
  pitch: z.number().finite(),
});

const itemStackSchema = z.object({
  // I. 为什么 item 严格、count 宽松
  // 1. 方块 id 会被写进 `Uint8Array` 交给渲染与物理层，超出 `0 .. 255` 会直接破坏世界
  //    数据，属于必须判为损坏的结构错误。
  // 2. 堆叠数量只影响 HUD 显示与合并逻辑，超出范围由 `normalizeInventory` 钳制到
  //    `1 .. MAX_STACK_SIZE`：一个坏掉的数字不应该让玩家失去整个背包。
  item: z.number().int().min(0).max(MAX_BLOCK_ID),
  count: z.number().int().min(1),
});

const inventorySchema = z.object({
  slots: z.array(itemStackSchema.nullable()),
  selected: z.number().int(),
});

const playerSchema = z.object({
  position: vectorSchema,
  rotation: rotationSchema,
  velocity: vectorSchema,
  health: z.number().finite(),
  inventory: inventorySchema,
});

const editSchema = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .max(CHUNK_VOLUME - 1),
  id: z.number().int().min(0).max(MAX_BLOCK_ID),
});

const legacyChunkSchema = z.object({
  cx: z.number().int(),
  cz: z.number().int(),
  edits: z.array(editSchema).max(CHUNK_VOLUME),
});

/**
 * v2 文档结构。
 *
 * `settings` 用 `z.unknown()` 接收后再交给 `normalizeSettings`：设置项是"可被玩家改坏"的
 * 软数据，逐字段校验只会让一个坏滑杆值毁掉整个存档，而钳制到默认值既安全又友好。
 */
const documentSchema = z.object({
  schemaVersion: z.number().int(),
  id: z.string().min(1),
  name: z.string(),
  seed: z.union([z.number().finite(), z.string()]),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  gameTime: z.number().finite(),
  player: playerSchema,
  settings: z.unknown(),
  legacyChunks: z.array(legacyChunkSchema).default([]),
});

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

/** 一个迁移步骤：把 vN 的文档就地升到 vN+1（返回新对象，不修改入参）。 */
type Migration = (document: RawDocument) => RawDocument;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function asVector(value: unknown, fallback: Vector3Value): Vector3Value {
  if (!isRecord(value)) {
    return fallback;
  }
  const { x, y, z } = value;
  return {
    x: typeof x === 'number' && Number.isFinite(x) ? x : fallback.x,
    y: typeof y === 'number' && Number.isFinite(y) ? y : fallback.y,
    z: typeof z === 'number' && Number.isFinite(z) ? z : fallback.z,
  };
}

function asRotation(value: unknown): RotationValue {
  if (!isRecord(value)) {
    return { yaw: 0, pitch: 0 };
  }
  const { yaw, pitch } = value;
  return {
    yaw: typeof yaw === 'number' && Number.isFinite(yaw) ? yaw : 0,
    pitch: typeof pitch === 'number' && Number.isFinite(pitch) ? pitch : 0,
  };
}

function asEdits(value: unknown): readonly BlockEdit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byIndex = new Map<number, BlockId>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const index = entry['index'];
    const id = entry['id'];
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      continue;
    }
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      continue;
    }
    if (index < 0 || index >= CHUNK_VOLUME || id < 0 || id > MAX_BLOCK_ID) {
      continue;
    }
    // I. 与 Chunk.applyEdits 一致：同一位置重复出现时后者获胜。
    byIndex.set(index, id as BlockId);
  }
  return [...byIndex].map(([index, id]) => ({ index, id }));
}

/**
 * v1 → v2。
 *
 * I. 这两个版本的真实差异
 *
 * 1. v1 用 `version` 字段，v2 改用 `schemaVersion`，避免与"世界版本"之类的概念混淆。
 * 2. v1 把区块修改内嵌在文档的 `blocks` 数组里，v2 拆到独立的 `chunks` 对象仓库；迁移
 *    把内嵌数据搬到 `legacyChunks`，由 `SaveManager.loadWorld` 合并，首次保存后清空。
 * 3. v1 的背包是裸数组 + 顶层 `selectedSlot`，v2 统一为 `{ slots, selected }`。
 * 4. v2 新增 `gameTime` 与 `settings`。
 */
function migrateV1ToV2(document: RawDocument): RawDocument {
  const rawPlayer = isRecord(document['player']) ? document['player'] : {};
  const rawInventory = rawPlayer['inventory'];
  const selectedSlot = rawPlayer['selectedSlot'];

  const slots = Array.isArray(rawInventory)
    ? rawInventory
    : isRecord(rawInventory) && Array.isArray(rawInventory['slots'])
      ? rawInventory['slots']
      : [];
  const selected =
    typeof selectedSlot === 'number'
      ? selectedSlot
      : isRecord(rawInventory) && typeof rawInventory['selected'] === 'number'
        ? rawInventory['selected']
        : 0;

  const legacyChunks = Array.isArray(document['blocks'])
    ? document['blocks'].flatMap((entry): LegacyChunkRecord[] => {
        if (!isRecord(entry)) {
          return [];
        }
        const cx = entry['cx'];
        const cz = entry['cz'];
        if (typeof cx !== 'number' || typeof cz !== 'number') {
          return [];
        }
        return [{ cx: Math.round(cx), cz: Math.round(cz), edits: asEdits(entry['edits']) }];
      })
    : [];

  return {
    schemaVersion: 2,
    id: document['id'],
    name: document['name'],
    seed: document['seed'],
    createdAt: document['createdAt'],
    updatedAt: document['updatedAt'],
    gameTime: typeof document['gameTime'] === 'number' ? document['gameTime'] : 0,
    player: {
      position: asVector(rawPlayer['position'], { x: 0, y: 64, z: 0 }),
      rotation: asRotation(rawPlayer['rotation']),
      // v1 没有速度字段：读档时静止是最安全的默认值。
      velocity: asVector(rawPlayer['velocity'], { x: 0, y: 0, z: 0 }),
      health: typeof rawPlayer['health'] === 'number' ? rawPlayer['health'] : MAX_HEALTH,
      inventory: { slots, selected },
    },
    settings: isRecord(document['settings']) ? document['settings'] : {},
    legacyChunks,
  };
}

/** 迁移步骤表：键是**源版本**。 */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: migrateV1ToV2,
};

/** 读取文档声明的版本号，兼容 v1 的 `version` 字段。 */
function readDocumentVersion(document: RawDocument): number {
  const direct = document['schemaVersion'];
  if (typeof direct === 'number') {
    return direct;
  }
  const legacy = document['version'];
  if (typeof legacy === 'number') {
    return legacy;
  }
  throw corrupted('存档缺少版本号字段（schemaVersion/version），无法确定格式');
}

/**
 * 把任意版本的存档文档逐级升级到 {@link SAVE_SCHEMA_VERSION}。
 *
 * @param raw - 从存储层读出的原始值。
 * @returns 未做 zod 校验的当前版本文档（结构校验由
 *          {@link parseWorldSaveDocument} 完成）。
 * @throws {AppError} `SAVE_VERSION_UNSUPPORTED`：版本高于当前程序。
 * @throws {AppError} `SAVE_CORRUPTED`：不是对象、缺版本号、版本非法或缺迁移步骤。
 */
export function migrate(raw: unknown): RawDocument {
  if (!isRecord(raw)) {
    throw corrupted(`存档根节点应为对象，实际为 ${raw === null ? 'null' : typeof raw}`);
  }

  let document: RawDocument = raw;
  let version = readDocumentVersion(document);

  if (!Number.isInteger(version)) {
    throw corrupted(`存档版本号必须是整数，实际为 ${String(version)}`);
  }
  if (version > SAVE_SCHEMA_VERSION) {
    throw new AppError(
      'SAVE_VERSION_UNSUPPORTED',
      `存档版本 v${version} 高于当前程序支持的 v${SAVE_SCHEMA_VERSION}`,
      { context: { version, supported: SAVE_SCHEMA_VERSION } },
    );
  }
  if (version < FIRST_SUPPORTED_SCHEMA_VERSION) {
    throw corrupted(`存档版本 v${version} 过旧，没有可用的迁移路径`);
  }

  while (version < SAVE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      throw corrupted(`缺少 v${version} → v${version + 1} 的迁移步骤`);
    }
    document = step(document);
    version += 1;
    document = { ...document, schemaVersion: version };
  }

  return document;
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

/** 尚未校验的堆叠结构；`item` 此时还只是 `number`。 */
interface RawItemStack {
  readonly item: number;
  readonly count: number;
}

/** 把任意长度的槽位数组补齐/截断到 {@link INVENTORY_SLOTS}，并钳制堆叠数量。 */
function normalizeInventory(raw: {
  readonly slots: readonly (RawItemStack | null)[];
  readonly selected: number;
}): InventorySnapshot {
  const slots: (ItemStack | null)[] = new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
  for (let index = 0; index < Math.min(raw.slots.length, INVENTORY_SLOTS); index += 1) {
    const stack = raw.slots[index];
    if (stack === null || stack === undefined) {
      continue;
    }
    const count = Math.round(clampNumber(stack.count, 1, MAX_STACK_SIZE));
    // `item` 已被 zod 限制在 `0 .. MAX_BLOCK_ID`；`BlockId` 是字面量联合，这里补上类型。
    slots[index] = { item: stack.item as BlockId, count };
  }
  const selected = ((Math.trunc(raw.selected) % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
  return { slots, selected };
}

function normalizePlayer(raw: z.infer<typeof playerSchema>): PlayerSaveState {
  return {
    position: { ...raw.position },
    rotation: { ...raw.rotation },
    velocity: { ...raw.velocity },
    health: clampNumber(raw.health, 0, MAX_HEALTH),
    inventory: normalizeInventory(raw.inventory),
  };
}

/**
 * 校验并规范化一个存档文档。
 *
 * @param raw - 任意版本的原始存档值。
 * @returns 当前版本、字段完整且取值合法的文档。
 * @throws {AppError} `SAVE_VERSION_UNSUPPORTED` 或 `SAVE_CORRUPTED`。
 */
export function parseWorldSaveDocument(raw: unknown): WorldSaveDocument {
  const migrated = migrate(raw);
  const parsed = documentSchema.safeParse(migrated);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? '' : issue.path.join('.');
    const detail = issue === undefined ? '未知原因' : issue.message;
    throw corrupted(
      `存档结构校验失败${path === '' ? '' : `（字段 ${path}）`}：${detail}`,
      parsed.error,
    );
  }

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    id: parsed.data.id,
    name: parsed.data.name,
    seed: parsed.data.seed,
    createdAt: parsed.data.createdAt,
    updatedAt: parsed.data.updatedAt,
    gameTime: parsed.data.gameTime,
    player: normalizePlayer(parsed.data.player),
    settings: normalizeSettings(parsed.data.settings),
    legacyChunks: parsed.data.legacyChunks.map((chunk) => ({
      cx: chunk.cx,
      cz: chunk.cz,
      edits: chunk.edits.map((edit) => ({ index: edit.index, id: edit.id as BlockId })),
    })),
  };
}

/**
 * 校验一段区块 edits 负载。
 *
 * @param raw - 从 chunks 仓库读出的值；必须是 edits 数组。
 * @param context - 出现在错误信息里的定位信息（世界 id + 区块键）。
 * @returns 去重后的修改列表，同一位置以最后一次为准。
 * @throws {AppError} `SAVE_CORRUPTED`：不是数组或存在非法条目。
 */
export function parseChunkEdits(raw: unknown, context: string): readonly BlockEdit[] {
  if (!Array.isArray(raw)) {
    throw corrupted(`区块 ${context} 的数据应为 edits 数组`);
  }
  const parsed = z.array(editSchema).max(CHUNK_VOLUME).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw corrupted(
      `区块 ${context} 的 edits 校验失败：${issue === undefined ? '未知原因' : issue.message}`,
      parsed.error,
    );
  }
  const byIndex = new Map<number, BlockId>();
  for (const edit of parsed.data) {
    byIndex.set(edit.index, edit.id as BlockId);
  }
  return [...byIndex].map(([index, id]) => ({ index, id }));
}

/**
 * 生成一个当前版本的存档文档。
 *
 * I. 为什么写入路径也走一次 `parseWorldSaveDocument`
 *
 * 1. "能写出的结构"必须正好是"能读回的结构"：如果写入时另写一套校验，两边迟早漂移，
 *    表现就是"保存成功但读档失败"。
 * 2. 因此这里先把入参拼成文档草稿，再交给同一条校验 + 规范化路径，读写的规范化规则
 *    （背包补齐、生命钳制、设置归一）天然只有一份实现。
 *
 * @param input - 待保存的世界状态。
 * @param now - 当前时间戳；由调用方注入以便测试。
 * @returns 可直接写入存储层的文档。
 * @throws {AppError} `SAVE_CORRUPTED`：入参本身不合法（例如空的 worldId）。
 */
export function createWorldDocument(input: SaveWorldInput, now: number): WorldSaveDocument {
  if (input.id.trim() === '') {
    throw corrupted('保存世界时 worldId 不能为空');
  }

  return parseWorldSaveDocument({
    schemaVersion: SAVE_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    seed: input.seed,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    gameTime: input.gameTime,
    player: {
      position: input.player.position,
      rotation: input.player.rotation,
      velocity: input.player.velocity,
      health: input.player.health,
      inventory: input.player.inventory,
    },
    settings: input.settings,
    legacyChunks: [],
  });
}

/** 把文档裁剪成列表条目。 */
export function toWorldSummary(document: WorldSaveDocument): WorldSummary {
  return {
    id: document.id,
    name: document.name,
    seed: document.seed,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    gameTime: document.gameTime,
  };
}

/**
 * 从存储层的世界文档里读取世界 id。
 *
 * 列表接口要在"完整校验"之前丢掉损坏条目，因此需要一个只读 id 的窄函数；
 * 缺 id 的文档无法定位，直接跳过。
 */
export function readWorldId(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = raw['id'];
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}
