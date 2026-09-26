/**
 * 存档存储层：一个窄接口 + IndexedDB 实现 + 内存实现。
 *
 * I. 为什么先定义 `SaveStorage` 再写 IndexedDB
 *
 * 1. `SaveManager` 承担的是"版本、迁移、规范化、节流"这些与存储无关的逻辑；如果它直接
 *    调用 `indexedDB`，这些逻辑就只能靠 `fake-indexeddb` 才能测。
 * 2. 把存储收窄成 6 个方法之后，测试可以注入内存实现，`SaveManager` 的行为变得确定且
 *    毫秒级；而 IndexedDB 实现本身再用 `fake-indexeddb` 单独验证。
 *
 * II. 为什么快照写入必须是一个事务
 *
 * 1. "世界元数据 + 该世界的全部区块修改"必须原子地一起更新。分两次事务写，进程被关闭时
 *    就会出现"玩家存档说在第 100 天，区块却是第 99 天的"这种撕裂状态。
 * 2. 因此接口只暴露 `writeWorldSnapshot`，内部用一个跨 `worlds`/`chunks` 两个仓库的
 *    readwrite 事务完成"删旧 + 写新"。
 *
 * III. 键的设计
 *
 * 1. `chunks` 仓库使用**显式字符串主键** `${worldId}:${chunkKey}`。显式主键让"按世界批量
 *    读取/删除"只需一次 `getAllKeys()` + 前缀过滤，不必为每个世界建索引。
 * 2. 值是 edits 数组本身（`[{index, id}, ...]`），没有包装层，便于用开发者工具直接查看。
 *
 * @module save/SaveStorage
 */

import { AppError } from '@/utils/errors';

/** 数据库名；与 package.json 中的项目名保持一致，便于排查。 */
export const SAVE_DATABASE_NAME = 'my-mc-v2';
/** 世界元数据对象仓库。 */
export const WORLD_STORE_NAME = 'worlds';
/** 区块修改对象仓库。 */
export const CHUNK_STORE_NAME = 'chunks';
/** IndexedDB 结构版本；只在对象仓库发生变化时 +1（与存档 schemaVersion 无关）。 */
export const SAVE_DATABASE_VERSION = 1;

/** 一个区块的待存储修改；`edits` 保持 `unknown`，结构校验属于上层。 */
export interface StoredChunkEdits {
  readonly chunkKey: number;
  readonly edits: unknown;
}

/**
 * 存储层接口。
 *
 * 世界文档以 `unknown` 进出：结构校验属于 `saveSchema`，存储层只负责搬运字节。
 */
export interface SaveStorage {
  /** 列出全部世界文档（可能包含损坏项，由调用方决定如何处理）。 */
  listWorldDocuments(): Promise<readonly unknown[]>;
  /**
   * 读取单个世界文档；记录不存在时兑现为 `null`。
   *
   * 返回类型写成 `unknown` 而不是 `unknown | null`：`unknown` 会吸收联合类型，显式写
   * `| null` 只会让类型读者以为 `null` 携带额外语义（它本来就是 `unknown` 的一个取值）。
   */
  readWorldDocument(worldId: string): Promise<unknown>;
  /** 读取某个世界全部区块修改。 */
  readChunkEdits(worldId: string): Promise<readonly StoredChunkEdits[]>;
  /** 原子地写入世界文档与该世界的区块快照（会清掉该世界此前多余的区块记录）。 */
  writeWorldSnapshot(
    worldId: string,
    document: unknown,
    chunks: readonly StoredChunkEdits[],
  ): Promise<void>;
  /** 删除世界及其全部区块记录。 */
  deleteWorld(worldId: string): Promise<void>;
  /** 关闭底层连接；幂等。 */
  close(): void;
}

function unavailable(message: string, cause?: unknown): AppError {
  return new AppError('STORAGE_UNAVAILABLE', message, cause === undefined ? {} : { cause });
}

/**
 * 组装区块记录主键。
 *
 * @param worldId - 世界 id。
 * @param chunkKeyValue - `chunkKey(cx, cz)` 的返回值。
 */
export function chunkRecordKey(worldId: string, chunkKeyValue: number): string {
  return `${worldId}:${chunkKeyValue}`;
}

/** 某个世界的区块记录键前缀。 */
export function chunkRecordPrefix(worldId: string): string {
  return `${worldId}:`;
}

/**
 * 从记录主键还原区块键。
 *
 * @param key - 存储层主键。
 * @param worldId - 期望的世界 id；前缀不匹配时返回 `null`。
 * @returns 区块键，或 `null` 表示这条记录不属于该世界/格式非法。
 */
export function parseChunkRecordKey(key: string, worldId: string): number | null {
  const prefix = chunkRecordPrefix(worldId);
  if (!key.startsWith(prefix)) {
    return null;
  }
  const suffix = key.slice(prefix.length);
  if (!/^-?\d+$/.test(suffix)) {
    return null;
  }
  const value = Number(suffix);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 内存存储实现。
 *
 * I. 用途
 *
 * 1. 测试：`SaveManager` 的往返、节流、删除逻辑不需要真实数据库。
 * 2. 降级：IndexedDB 不可用（隐私模式）时，应用可以选择"本次会话内存存档"，让玩家至少能
 *    玩完一局再导出。
 *
 * II. 语义与 IndexedDB 实现保持一致
 *
 * 1. 键同样使用 `${worldId}:${chunkKey}`，因此两条路径的键处理代码可以共用同一套前缀
 *    函数，测试覆盖到的边界（负数区块键、非法后缀）对两者都成立。
 * 2. 写入时深拷贝，避免调用方之后修改对象导致"存档被就地改动"。
 */
export class InMemorySaveStorage implements SaveStorage {
  readonly #worlds = new Map<string, unknown>();
  readonly #chunks = new Map<string, unknown>();

  public listWorldDocuments(): Promise<readonly unknown[]> {
    return Promise.resolve([...this.#worlds.values()]);
  }

  public readWorldDocument(worldId: string): Promise<unknown> {
    return Promise.resolve(this.#worlds.has(worldId) ? (this.#worlds.get(worldId) ?? null) : null);
  }

  public readChunkEdits(worldId: string): Promise<readonly StoredChunkEdits[]> {
    const prefix = chunkRecordPrefix(worldId);
    const result: StoredChunkEdits[] = [];
    for (const [key, edits] of this.#chunks) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const chunkKeyValue = parseChunkRecordKey(key, worldId);
      if (chunkKeyValue === null) {
        continue;
      }
      result.push({ chunkKey: chunkKeyValue, edits });
    }
    return Promise.resolve(result);
  }

  public writeWorldSnapshot(
    worldId: string,
    document: unknown,
    chunks: readonly StoredChunkEdits[],
  ): Promise<void> {
    // I. 先删除该世界此前的区块记录，再写入快照：
    // 1. 快照是"权威集合"，上一次保存过、这一次没被修改的区块不应残留。
    const prefix = chunkRecordPrefix(worldId);
    for (const key of [...this.#chunks.keys()]) {
      if (key.startsWith(prefix)) {
        this.#chunks.delete(key);
      }
    }
    for (const chunk of chunks) {
      this.#chunks.set(chunkRecordKey(worldId, chunk.chunkKey), cloneValue(chunk.edits));
    }
    this.#worlds.set(worldId, cloneValue(document));
    return Promise.resolve();
  }

  public deleteWorld(worldId: string): Promise<void> {
    this.#worlds.delete(worldId);
    const prefix = chunkRecordPrefix(worldId);
    for (const key of [...this.#chunks.keys()]) {
      if (key.startsWith(prefix)) {
        this.#chunks.delete(key);
      }
    }
    return Promise.resolve();
  }

  public close(): void {
    // 内存实现没有需要释放的资源；保留方法以满足接口。
  }
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// IndexedDB 实现
// ---------------------------------------------------------------------------

export interface IndexedDbSaveStorageOptions {
  /** 数据库名；测试可以换名以避免用例互相污染。 */
  readonly databaseName?: string;
  /** 注入 IDBFactory；默认取全局 `indexedDB`。 */
  readonly factory?: IDBFactory;
}

/**
 * 创建 IndexedDB 存档存储。
 *
 * @param options - 数据库名与工厂注入。
 * @throws {AppError} `STORAGE_UNAVAILABLE`：环境没有 `indexedDB`（隐私模式或非浏览器环境）。
 */
export function createIndexedDbSaveStorage(options: IndexedDbSaveStorageOptions = {}): SaveStorage {
  const scope = globalThis as { indexedDB?: IDBFactory };
  const factory = options.factory ?? scope.indexedDB;
  if (factory === undefined) {
    throw unavailable('当前环境没有 IndexedDB，存档无法持久化');
  }
  return new IndexedDbSaveStorage({
    factory,
    ...(options.databaseName === undefined ? {} : { databaseName: options.databaseName }),
  });
}

/**
 * IndexedDB 存储实现。
 *
 * I. 连接是懒创建的
 *
 * 1. 构造函数不做 I/O：`new SaveManager()` 不应该因为"数据库暂时打不开"而失败，失败要在
 *    真正读写时以 `AppError('STORAGE_UNAVAILABLE')` 呈现，让界面有机会提示玩家。
 * 2. 打开失败时不缓存失败的 promise，下一次调用会重试（例如玩家刚退出隐私模式）。
 *
 * II. 为什么每个事务都先登记完成事件
 *
 * 1. `await` 某个请求的 promise 之后，事务可能已经进入"提交"阶段；如果这时才挂
 *    `oncomplete`，事件已经派发过，promise 永远不会 settle → 调用方挂死。
 * 2. 因此统一模式是：创建事务 → 立刻 `const done = transactionDone(tx)` → 发请求 →
 *    `await done`。
 */
export class IndexedDbSaveStorage implements SaveStorage {
  readonly #factory: IDBFactory;
  readonly #databaseName: string;
  #database: IDBDatabase | null = null;
  #opening: Promise<IDBDatabase> | null = null;

  public constructor(options: { readonly factory: IDBFactory; readonly databaseName?: string }) {
    this.#factory = options.factory;
    this.#databaseName = options.databaseName ?? SAVE_DATABASE_NAME;
  }

  /** 当前数据库名；调试与测试用。 */
  public get databaseName(): string {
    return this.#databaseName;
  }

  public async listWorldDocuments(): Promise<readonly unknown[]> {
    const db = await this.#open();
    const tx = db.transaction(WORLD_STORE_NAME, 'readonly');
    const done = transactionDone(tx);
    const values = await requestResult<unknown[]>(
      tx.objectStore(WORLD_STORE_NAME).getAll(),
    );
    await done;
    return values;
  }

  public async readWorldDocument(worldId: string): Promise<unknown> {
    const db = await this.#open();
    const tx = db.transaction(WORLD_STORE_NAME, 'readonly');
    const done = transactionDone(tx);
    const value = await requestResult<unknown>(tx.objectStore(WORLD_STORE_NAME).get(worldId));
    await done;
    return value ?? null;
  }

  public async readChunkEdits(worldId: string): Promise<readonly StoredChunkEdits[]> {
    const db = await this.#open();
    const tx = db.transaction(CHUNK_STORE_NAME, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(CHUNK_STORE_NAME);
    const [keys, values] = await Promise.all([
      requestResult<IDBValidKey[]>(store.getAllKeys()),
      requestResult<unknown[]>(store.getAll()),
    ]);
    await done;

    const result: StoredChunkEdits[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') {
        continue;
      }
      const chunkKeyValue = parseChunkRecordKey(key, worldId);
      if (chunkKeyValue === null) {
        continue;
      }
      result.push({ chunkKey: chunkKeyValue, edits: values[index] });
    }
    return result;
  }

  public async writeWorldSnapshot(
    worldId: string,
    document: unknown,
    chunks: readonly StoredChunkEdits[],
  ): Promise<void> {
    // I. 先读出需要清理的旧键。
    // 1. 单独一次只读事务；随后的一次读写事务只做"删旧 + 写新"，内部不再 await，
    //    因此不会遇到 IndexedDB 事务自动提交的问题。
    const staleKeys = await this.#chunkKeys(worldId);

    const db = await this.#open();
    const tx = db.transaction([WORLD_STORE_NAME, CHUNK_STORE_NAME], 'readwrite');
    const done = transactionDone(tx);
    try {
      tx.objectStore(WORLD_STORE_NAME).put(document);
      const chunkStore = tx.objectStore(CHUNK_STORE_NAME);
      for (const key of staleKeys) {
        chunkStore.delete(key);
      }
      for (const chunk of chunks) {
        chunkStore.put(chunk.edits, chunkRecordKey(worldId, chunk.chunkKey));
      }
    } catch (error) {
      // 同步抛出的写入错误（例如文档不可结构化克隆）必须中止事务，避免半个存档。
      try {
        tx.abort();
      } catch {
        // 事务可能已经中止；忽略。
      }
      throw unavailable('写入存档失败', error);
    }
    await done;
  }

  public async deleteWorld(worldId: string): Promise<void> {
    const staleKeys = await this.#chunkKeys(worldId);

    const db = await this.#open();
    const tx = db.transaction([WORLD_STORE_NAME, CHUNK_STORE_NAME], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(WORLD_STORE_NAME).delete(worldId);
    const chunkStore = tx.objectStore(CHUNK_STORE_NAME);
    for (const key of staleKeys) {
      chunkStore.delete(key);
    }
    await done;
  }

  public close(): void {
    const db = this.#database;
    this.#database = null;
    this.#opening = null;
    if (db !== null) {
      db.close();
    }
  }

  /** 该世界全部区块记录键；用于快照写入与删除前的清理。 */
  async #chunkKeys(worldId: string): Promise<readonly string[]> {
    const db = await this.#open();
    const tx = db.transaction(CHUNK_STORE_NAME, 'readonly');
    const done = transactionDone(tx);
    const keys = await requestResult<IDBValidKey[]>(tx.objectStore(CHUNK_STORE_NAME).getAllKeys());
    await done;
    return keys.filter((key): key is string => {
      return typeof key === 'string' && parseChunkRecordKey(key, worldId) !== null;
    });
  }

  async #open(): Promise<IDBDatabase> {
    if (this.#database !== null) {
      return this.#database;
    }
    if (this.#opening !== null) {
      return this.#opening;
    }

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.#factory.open(this.#databaseName, SAVE_DATABASE_VERSION);
      } catch (cause) {
        reject(unavailable(`无法打开存档数据库 ${this.#databaseName}`, cause));
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(WORLD_STORE_NAME)) {
          // 世界文档自带 id，使用 keyPath 让 put 不必显式传键。
          db.createObjectStore(WORLD_STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          // 区块仓库使用显式键 `${worldId}:${chunkKey}`。
          db.createObjectStore(CHUNK_STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // 另一个标签页要求升级时主动让路，否则对方会一直卡在 blocked。
        db.onversionchange = () => {
          db.close();
          if (this.#database === db) {
            this.#database = null;
          }
        };
        resolve(db);
      };
      request.onerror = () => {
        reject(unavailable(`打开存档数据库 ${this.#databaseName} 失败`, request.error));
      };
      request.onblocked = () => {
        reject(
          unavailable(
            `存档数据库 ${this.#databaseName} 被另一个标签页占用，请关闭其他游戏页面后重试`,
          ),
        );
      };
    });

    this.#opening = opening;
    try {
      const db = await opening;
      this.#database = db;
      return db;
    } finally {
      this.#opening = null;
    }
  }
}

/** 包装一次请求：成功给结果，失败给 `STORAGE_UNAVAILABLE`。 */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(unavailable('IndexedDB 请求失败', request.error));
    };
  });
}

/**
 * 事务完成信号。
 *
 * 立刻给返回的 promise 挂一个空 catch：调用方可能稍后才 `await`，而中间若发生错误会产生
 * "未处理的 promise 拒绝"告警（在浏览器里会污染控制台，自动化测试也会误判）。
 */
function transactionDone(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(unavailable('IndexedDB 事务被中止', tx.error));
    };
    tx.onerror = () => {
      reject(unavailable('IndexedDB 事务失败', tx.error));
    };
  });
  done.catch(() => {
    // 真正的错误由 `await done` 处抛出；这里只负责标记已处理。
  });
  return done;
}
