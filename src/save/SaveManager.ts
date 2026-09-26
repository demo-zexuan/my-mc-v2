/**
 * 存档管理器：世界列表、读写、删除与自动保存。
 *
 * I. 职责边界
 *
 * 1. 面向调用方（应用装配层）的只有本类；它负责版本迁移、结构校验、世界文档的组装、
 *    "只存被修改过的区块"这条裁剪规则，以及自动保存的节流。
 * 2. 底层搬运交给 `SaveStorage`；数据库不可用时抛 `AppError('STORAGE_UNAVAILABLE')`，
 *    是否降级为"内存存档 + 提示玩家"由装配层决定（本类不替调用方做产品决策）。
 *
 * II. 为什么不依赖 Three.js
 *
 * 1. 存档层只处理数字与数组：`BlockEdit` 是 `{index, id}`，玩家状态是坐标 + 朝向 +
 *    背包快照。引入 Three.js 只会把"能否在无 WebGL 环境下测试存档"变成一个问题。
 * 2. 因此本模块的 import 全部是类型与纯数据模块，可以在 node 环境下直接单元测试。
 *
 * III. 自动保存
 *
 * 1. `noteChunkModified(count)` 由交互层在每次方块修改后调用；累计到阈值立即触发一次保存。
 * 2. `startAutosave(provider)` 额外注册一个定时器，每 `intervalMs`（默认 20 秒）检查一次；
 *    真正落盘的数据由 `provider()` 现场收集，避免存档层持有世界对象。
 *
 * @module save/SaveManager
 */

import { AppError } from '@/utils/errors';
import { logger as defaultLogger, type Logger } from '@/utils/logger';
import type { BlockEdit } from '@/world/Chunk';
import { chunkKey, chunkKeyToCoord } from '@/world/coords';
import {
  DEFAULT_AUTOSAVE_CHANGE_THRESHOLD,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  AutosaveThrottle,
  type AutosaveThrottleOptions,
} from './AutosaveThrottle';
import { createIndexedDbSaveStorage, type SaveStorage, type StoredChunkEdits } from './SaveStorage';
import {
  createWorldDocument,
  parseChunkEdits,
  parseWorldSaveDocument,
  readWorldId,
  toWorldSummary,
  type ChunkSaveInput,
  type PlayerSaveState,
  type SaveWorldInput,
  type WorldSaveDocument,
  type WorldSummary,
} from './saveSchema';

/** 读档结果中的区块修改。 */
export interface LoadedChunk {
  /** 区块 X 坐标。 */
  readonly cx: number;
  /** 区块 Z 坐标。 */
  readonly cz: number;
  /** `chunkKey(cx, cz)`，便于调用方放进 `Map`。 */
  readonly chunkKey: number;
  /** 需要交给 `Chunk.applyEdits` 的修改列表。 */
  readonly edits: readonly BlockEdit[];
}

/** 读档结果。 */
export interface LoadedWorld {
  readonly worldId: string;
  readonly worldName: string;
  readonly seed: number | string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly gameTime: number;
  readonly player: PlayerSaveState;
  readonly settings: WorldSaveDocument['settings'];
  /** 仅包含被修改过的区块。 */
  readonly chunks: readonly LoadedChunk[];
}

export interface SaveManagerOptions {
  /** 存储实现；默认 IndexedDB，测试与降级场景可注入内存实现。 */
  readonly storage?: SaveStorage;
  readonly logger?: Logger;
  /** 时钟注入。 */
  readonly now?: () => number;
  /** 自动保存节流参数。 */
  readonly autosave?: AutosaveThrottleOptions;
}

/** 触发自动保存的原因；仅用于日志与测试断言。 */
export type AutosaveReason = 'change-threshold' | 'interval' | 'manual';

export class SaveManager {
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #throttle: AutosaveThrottle;
  readonly #intervalMs: number;

  #storage: SaveStorage | null;
  #autosaveProvider: (() => SaveWorldInput | null) | null = null;
  #autosaveTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;
  #autosaveInFlight = false;

  public constructor(options: SaveManagerOptions = {}) {
    this.#logger = (options.logger ?? defaultLogger).child('save');
    this.#now = options.now ?? Date.now;
    this.#throttle = new AutosaveThrottle({
      ...(options.autosave ?? {}),
      now: this.#now,
    });
    // 复用节流器已经过滤过的间隔值，避免两处各自处理非法配置。
    this.#intervalMs = this.#throttle.intervalMs;
    this.#storage = options.storage ?? null;
  }

  /** 自上次保存以来的待保存修改次数。 */
  public get pendingChanges(): number {
    return this.#throttle.pendingChanges;
  }

  /** 是否存在尚未落盘的改动。 */
  public get isDirty(): boolean {
    return this.#throttle.dirty;
  }

  /** 自动保存是否已注册。 */
  public get isAutosaveRunning(): boolean {
    return this.#autosaveTimer !== null;
  }

  /**
   * 列出全部世界。
   *
   * 单个损坏的存档只记录 warn 并跳过：一个坏文件不应该让"世界列表"整个打不开。
   *
   * @returns 按更新时间倒序排列的世界摘要。
   */
  public async listWorlds(): Promise<readonly WorldSummary[]> {
    const storage = this.#requireStorage();
    const documents = await storage.listWorldDocuments();
    const summaries: WorldSummary[] = [];
    for (const document of documents) {
      try {
        summaries.push(toWorldSummary(parseWorldSaveDocument(document)));
      } catch (error) {
        this.#logger.warn(`跳过无法读取的世界存档（id=${readWorldId(document) ?? '未知'}）`, error);
      }
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * 读取一个世界。
   *
   * @param worldId - 世界 id。
   * @throws {AppError} `SAVE_CORRUPTED`：记录不存在或结构损坏。
   * @throws {AppError} `SAVE_VERSION_UNSUPPORTED`：存档版本高于当前程序。
   * @throws {AppError} `STORAGE_UNAVAILABLE`：数据库不可用。
   */
  public async loadWorld(worldId: string): Promise<LoadedWorld> {
    const storage = this.#requireStorage();
    const raw = await storage.readWorldDocument(worldId);
    if (raw === null) {
      throw new AppError('SAVE_CORRUPTED', `世界 ${worldId} 的存档不存在或已被删除`, {
        context: { worldId },
      });
    }

    const document = parseWorldSaveDocument(raw);
    const storedChunks = await storage.readChunkEdits(worldId);
    const chunks = new Map<number, BlockEdit[]>();

    // I. 先放入 v1 迁移过来的内嵌区块数据，再让独立的区块记录覆盖它：
    // 1. 老存档第一次被保存后，区块数据会被提升为独立记录，此时独立记录更新。
    for (const legacy of document.legacyChunks) {
      const key = chunkKey(legacy.cx, legacy.cz);
      chunks.set(key, [...(chunks.get(key) ?? []), ...legacy.edits]);
    }
    for (const chunk of storedChunks) {
      const context = `${worldId}:${chunk.chunkKey}`;
      chunks.set(chunk.chunkKey, [...parseChunkEdits(chunk.edits, context)]);
    }

    const loaded: LoadedChunk[] = [];
    for (const [key, edits] of chunks) {
      if (edits.length === 0) {
        continue;
      }
      const { cx, cz } = chunkKeyToCoord(key);
      loaded.push({ cx, cz, chunkKey: key, edits });
    }

    this.#logger.debug(
      `已读取世界 ${document.name}（${document.id}）：${loaded.length} 个被修改的区块`,
    );

    return {
      worldId: document.id,
      worldName: document.name,
      seed: document.seed,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      gameTime: document.gameTime,
      player: document.player,
      settings: document.settings,
      chunks: loaded,
    };
  }

  /**
   * 保存一个世界。
   *
   * I. 只写被修改过的区块
   *
   * 1. 调用方传入的 `chunks` 通常直接来自"被标记为 modified 的区块"，空 edits 的区块会被
   *    这里再过滤一次，避免把可重新生成的地形写进存档。
   * 2. `createdAt` 取自磁盘上已有文档，因此重复保存不会刷新创建时间。
   *
   * @param input - 待保存的世界状态。
   * @returns 写入后的世界摘要。
   * @throws {AppError} `SAVE_CORRUPTED`：入参不合法。
   * @throws {AppError} `STORAGE_UNAVAILABLE`：数据库不可用（调用方决定是否降级）。
   */
  public async saveWorld(input: SaveWorldInput): Promise<WorldSummary> {
    const storage = this.#requireStorage();
    const now = this.#now();
    const createdAt = await this.#existingCreatedAt(storage, input.id, now);
    const document = createWorldDocument({ ...input, createdAt }, now);
    const chunks = this.#collectChunkPayloads(input.chunks);

    await storage.writeWorldSnapshot(document.id, document, chunks);
    this.#throttle.markSaved();
    this.#logger.debug(
      `已保存世界 ${document.name}（${document.id}）：${chunks.length} 个被修改的区块`,
    );
    return toWorldSummary(document);
  }

  /** 世界是否存在。 */
  public async hasWorld(worldId: string): Promise<boolean> {
    const storage = this.#requireStorage();
    return (await storage.readWorldDocument(worldId)) !== null;
  }

  /**
   * 删除一个世界及其全部区块记录。
   *
   * @param worldId - 世界 id。
   */
  public async deleteWorld(worldId: string): Promise<void> {
    const storage = this.#requireStorage();
    await storage.deleteWorld(worldId);
    this.#logger.debug(`已删除世界 ${worldId}`);
  }

  /**
   * 记录方块修改；达到阈值时立即请求一次自动保存。
   *
   * @param count - 本次修改数量，默认 1。
   * @returns 是否因此触发了一次自动保存请求。
   */
  public noteChunkModified(count = 1): boolean {
    if (this.#disposed) {
      return false;
    }
    if (!this.#throttle.noteChange(count)) {
      return false;
    }
    this.#requestAutosave('change-threshold');
    return true;
  }

  /**
   * 注册自动保存：定时器每 `intervalMs` 检查一次，数据由 `provider` 现场收集。
   *
   * @param provider - 返回本次要保存的快照；返回 `null` 表示暂不保存（例如正在加载世界）。
   */
  public startAutosave(provider: () => SaveWorldInput | null): void {
    this.stopAutosave();
    this.#autosaveProvider = provider;
    this.#autosaveTimer = setInterval(() => {
      void this.tickAutosave();
    }, this.#intervalMs);
  }

  /** 注销自动保存；幂等。 */
  public stopAutosave(): void {
    if (this.#autosaveTimer !== null) {
      clearInterval(this.#autosaveTimer);
      this.#autosaveTimer = null;
    }
    this.#autosaveProvider = null;
  }

  /**
   * 按间隔条件尝试一次自动保存；由定时器调用，也可在测试中显式调用。
   *
   * @returns 是否真的写入了存档。
   */
  public async tickAutosave(): Promise<boolean> {
    if (!this.#throttle.shouldTrigger()) {
      return false;
    }
    return this.#runAutosave('interval');
  }

  /**
   * 立即自动保存（忽略时间间隔，但仍要求存在未保存改动）。
   *
   * 用于"暂停""退出到主菜单"等明确的保存时机。
   *
   * @returns 是否真的写入了存档。
   */
  public async autosaveNow(): Promise<boolean> {
    if (!this.#throttle.dirty) {
      return false;
    }
    return this.#runAutosave('manual');
  }

  /** 释放定时器并关闭存储连接；幂等。 */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.stopAutosave();
    this.#storage?.close();
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 取得存储实现；未注入时懒创建 IndexedDB 实现（构造期不做 I/O）。 */
  #requireStorage(): SaveStorage {
    if (this.#storage !== null) {
      return this.#storage;
    }
    const created = createIndexedDbSaveStorage();
    this.#storage = created;
    return created;
  }

  /** 读取磁盘上已有文档的创建时间；不存在或损坏时用当前时间。 */
  async #existingCreatedAt(
    storage: SaveStorage,
    worldId: string,
    fallback: number,
  ): Promise<number> {
    try {
      const raw = await storage.readWorldDocument(worldId);
      if (raw === null) {
        return fallback;
      }
      return parseWorldSaveDocument(raw).createdAt;
    } catch (error) {
      // 覆盖损坏的存档是合理的恢复路径：此时保留"创建时间"没有意义。
      this.#logger.warn(`读取 ${worldId} 的旧存档失败，将按新存档写入`, error);
      return fallback;
    }
  }

  /** 裁剪并校验待写入的区块负载。 */
  #collectChunkPayloads(chunks: readonly ChunkSaveInput[]): StoredChunkEdits[] {
    const byKey = new Map<number, readonly BlockEdit[]>();
    for (const chunk of chunks) {
      const key = chunkKey(chunk.cx, chunk.cz);
      const edits = parseChunkEdits(chunk.edits, `${chunk.cx},${chunk.cz}`);
      if (edits.length === 0) {
        // 没有被修改的区块不落盘：它们可以由种子重新生成。
        byKey.delete(key);
        continue;
      }
      byKey.set(key, edits);
    }
    return [...byKey].map(([key, edits]) => ({ chunkKey: key, edits }));
  }

  /** 触发一次后台自动保存；错误只记录日志，绝不冒泡（定时器上下文没有调用方可以接）。 */
  #requestAutosave(reason: AutosaveReason): void {
    void this.#runAutosave(reason).then((saved) => {
      if (saved) {
        this.#logger.debug(`自动保存完成（${reason}）`);
      }
    });
  }

  async #runAutosave(reason: AutosaveReason): Promise<boolean> {
    const provider = this.#autosaveProvider;
    if (provider === null || this.#autosaveInFlight || this.#disposed) {
      return false;
    }
    this.#autosaveInFlight = true;
    try {
      const input = provider();
      if (input === null) {
        return false;
      }
      await this.saveWorld(input);
      return true;
    } catch (error) {
      // I. 自动保存失败不能打断游戏：
      // 1. 脏标记保持为 true，下一次间隔或阈值仍会重试。
      // 2. 日志带上原因，便于区分"存储不可用"与"数据不合法"。
      this.#logger.warn(`自动保存失败（${reason}），将在下次触发时重试`, error);
      return false;
    } finally {
      this.#autosaveInFlight = false;
    }
  }
}

/** 供装配层复用的默认自动保存参数。 */
export const AUTOSAVE_DEFAULTS = {
  intervalMs: DEFAULT_AUTOSAVE_INTERVAL_MS,
  changeThreshold: DEFAULT_AUTOSAVE_CHANGE_THRESHOLD,
} as const;
