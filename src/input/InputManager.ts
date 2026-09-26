/**
 * 键鼠输入与指针锁定。
 *
 * I. 为什么需要"动作层"而不是直接暴露按键码
 *
 * 1. 玩法代码只关心"向前 / 跳跃 / 挖掘"这些**意图**，不关心玩家用的是 `KeyW` 还是
 *    方向键、左手 Shift 还是右手 Shift。把映射集中在一个只读表里，控制器里就不会
 *    散落 `code === 'KeyW' || code === 'ArrowUp'` 这样的判断。
 * 2. 键位将来要可配置（设置界面），映射表就是唯一的改动点。
 *
 * II. 边沿语义与固定时间步
 *
 * 1. "刚按下 / 刚释放"是**步内边沿**：在两次 `endStep()` 之间保持为 true。
 *    游戏循环必须在每个固定步的**所有系统读完之后**调用一次 `endStep()`，
 *    否则一次按下可能被两个步看到，或者被完全错过。
 * 2. 高频连点（60Hz 内按下又放开）会同时出现在边沿集合中，这是刻意的：跳跃缓冲
 *    与挖掘系统都依赖"这一步内发生过按下"，而不是"此刻仍按住"。
 *
 * III. 焦点、暂停与指针锁定
 *
 * 1. `setEnabled(false)` 表示输入焦点不在游戏上（打开背包、设置等模态界面），
 *    此时移动意图恒为中性。禁用会**清空**按键状态：否则玩家在 UI 里按下的 W
 *    会在关闭界面的瞬间变成"一直向前走"。
 * 2. 玩家按 Esc 时浏览器不会把 `keydown` 交给页面，只会解除指针锁定。因此暂停
 *    必须由 `pointerlockchange` 驱动：失去锁定时自动 `setPaused(true)`，重新获得
 *    锁定时自动恢复。这样"按 Esc 继续转视角"这类问题在输入层就被消除。
 * 3. 鼠标位移只在锁定状态下累积，并带**忽略非有限值**的保护：某些远端桌面/虚拟
 *    输入设备会给出 `NaN` 的 `movementX`，一旦写进 yaw 就再也回不来。
 *
 * IV. 环境假设
 *
 * 本模块必然依赖 DOM（键鼠事件与指针锁定没有替代品），但所有事件都在
 * `window` / 传入元素上注册，构造时不做任何查询，因此可以在 jsdom 下完整测试。
 *
 * @module input/InputManager
 */

import { HOTBAR_SLOTS } from '@/inventory/types';

/** 玩法意图。控制器只消费这些，不消费按键码。 */
export type InputAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'sneak'
  | 'attack'
  | 'use'
  | 'pick'
  | 'inventory'
  | 'drop'
  | 'pause';

/**
 * 默认键位。
 *
 * I. 为什么键盘用 `event.code` 而不是 `event.key`
 *
 * 1. `code` 是物理位置，AZERTY / Dvorak 玩家用同一组键位也能得到"手放在哪就走向
 *    哪"的体验；`key` 会随布局和 Shift 改变大小写，做绑定表非常脆弱。
 * 2. 鼠标键与键盘共用一个码空间（`Mouse0` / `Mouse2`），动作层因此不需要区分
 *    "键"与"钮"两套状态。
 */
export const DEFAULT_BINDINGS: Readonly<Record<InputAction, readonly string[]>> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  sneak: ['ControlLeft', 'ControlRight'],
  attack: ['Mouse0'],
  use: ['Mouse2'],
  pick: ['Mouse1'],
  inventory: ['KeyE'],
  drop: ['KeyQ'],
  pause: ['Escape'],
};

/** 每步移动意图；暂停或输入焦点不在游戏上时全部为 false。 */
export interface MoveIntent {
  readonly forward: boolean;
  readonly back: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly jump: boolean;
  readonly sprint: boolean;
  readonly sneak: boolean;
}

/** 中性意图：暂停、UI 打开、无输入时复用同一个对象，避免每步分配。 */
const NEUTRAL_INTENT: MoveIntent = Object.freeze({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  sneak: false,
});

/** 鼠标位移（像素）。 */
export interface LookDelta {
  readonly dx: number;
  readonly dy: number;
}

/** 构造参数。 */
export interface InputManagerOptions {
  /** 接收鼠标事件与滚轮的元素（通常是游戏 canvas），默认 `document.documentElement`。 */
  readonly element?: HTMLElement;
  /** 覆盖默认键位；未给出的动作沿用 {@link DEFAULT_BINDINGS}。 */
  readonly bindings?: Partial<Record<InputAction, readonly string[]>>;
  /** 滚轮是否切换快捷栏槽位，默认 true（与 MC 一致）。 */
  readonly scrollSelectsHotbar?: boolean;
  /** 指针锁定状态变化的回调，用于显示/隐藏暂停菜单。 */
  readonly onPointerLockChange?: (locked: boolean) => void;
}

/** 数字键 `Digit1` .. `Digit9` 到槽位下标的映射。 */
const DIGIT_CODE_PATTERN = /^Digit([1-9])$/;

export class InputManager {
  readonly #element: HTMLElement;
  readonly #bindings: Readonly<Record<InputAction, readonly string[]>>;
  readonly #boundCodes: ReadonlySet<string>;
  readonly #scrollSelectsHotbar: boolean;
  readonly #pointerLockListener: ((locked: boolean) => void) | null;

  readonly #down = new Set<string>();
  readonly #pressed = new Set<string>();
  readonly #released = new Set<string>();

  #lookDx = 0;
  #lookDy = 0;
  #wheelDelta = 0;
  #hotbarSlot = 0;
  #hotbarSlotChanged: number | null = null;

  #pointerLocked = false;
  #paused = false;
  /** 是否处于"按住左键拖拽转向"回退模式。 */
  #lookDragging = false;
  /** 左键是否按住；与拖拽回退配对。 */
  #primaryButtonDown = false;
  #enabled = true;
  #disposed = false;

  public constructor(options: InputManagerOptions = {}) {
    this.#element = options.element ?? document.documentElement;
    this.#scrollSelectsHotbar = options.scrollSelectsHotbar ?? true;
    this.#pointerLockListener = options.onPointerLockChange ?? null;

    // I. 合并键位并预先算出"被绑定的物理码"集合。
    // 1. 事件回调每步可能触发多次（连点、组合键），集合查询比遍历动作表更省；
    //    而且只有被绑定的码才需要 `preventDefault`，避免干扰 F3 之类的调试快捷键。
    const merged = { ...DEFAULT_BINDINGS, ...options.bindings };
    this.#bindings = merged;
    const boundCodes = new Set<string>();
    for (const action of Object.keys(merged) as InputAction[]) {
      for (const code of merged[action]) {
        boundCodes.add(code);
      }
    }
    this.#boundCodes = boundCodes;

    this.#attach();
  }

  // -------------------------------------------------------------------------
  // 状态查询
  // -------------------------------------------------------------------------

  /** 指针是否被锁定；未锁定时不应累积视角位移。 */
  public get pointerLocked(): boolean {
    return this.#pointerLocked;
  }

  /** 是否处于暂停（丢失指针锁定或由外部显式设置）。 */
  public get paused(): boolean {
    return this.#paused;
  }

  /** 输入焦点是否在游戏上；为 false 时移动意图恒为中性。 */
  public get enabled(): boolean {
    return this.#enabled;
  }

  /** 当前选中的快捷栏槽位（`0 .. HOTBAR_SLOTS - 1`）。 */
  public get hotbarSlot(): number {
    return this.#hotbarSlot;
  }

  /** 接收鼠标事件的元素，主要供测试使用。 */
  public get element(): HTMLElement {
    return this.#element;
  }

  /** 某个物理码是否处于按下状态。 */
  public isDown(code: string): boolean {
    return this.#down.has(code);
  }

  /** 某个物理码是否在**本步内**刚被按下。 */
  public wasPressed(code: string): boolean {
    return this.#pressed.has(code);
  }

  /** 某个物理码是否在**本步内**刚被释放。 */
  public wasReleased(code: string): boolean {
    return this.#released.has(code);
  }

  /** 动作对应的任意按键是否按下。 */
  public isActionDown(action: InputAction): boolean {
    for (const code of this.#bindings[action]) {
      if (this.#down.has(code)) {
        return true;
      }
    }
    return false;
  }

  /** 动作是否在本步内刚被按下。 */
  public wasActionPressed(action: InputAction): boolean {
    for (const code of this.#bindings[action]) {
      if (this.#pressed.has(code)) {
        return true;
      }
    }
    return false;
  }

  /** 动作是否在本步内刚被释放。 */
  public wasActionReleased(action: InputAction): boolean {
    for (const code of this.#bindings[action]) {
      if (this.#released.has(code)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 本步的移动意图。
   *
   * 暂停或输入焦点不在游戏上时返回中性意图，调用方不需要自己判断暂停状态——
   * 这样"UI 打开时角色还在走"这类 bug 不可能出现。
   */
  public moveIntent(): MoveIntent {
    if (!this.#enabled || this.#paused) {
      return NEUTRAL_INTENT;
    }
    return {
      forward: this.isActionDown('forward'),
      back: this.isActionDown('back'),
      left: this.isActionDown('left'),
      right: this.isActionDown('right'),
      jump: this.isActionDown('jump'),
      sprint: this.isActionDown('sprint'),
      sneak: this.isActionDown('sneak'),
    };
  }

  /**
   * 取出并清零本步累积的鼠标位移。
   *
   * @returns 像素位移；未锁定时恒为 0。
   */
  public consumeLookDelta(): LookDelta {
    const delta: LookDelta = { dx: this.#lookDx, dy: this.#lookDy };
    this.#lookDx = 0;
    this.#lookDy = 0;
    return delta;
  }

  /** 取出并清零滚轮累积量（`deltaY` 之和，向下滚为正）。 */
  public consumeWheelDelta(): number {
    const delta = this.#wheelDelta;
    this.#wheelDelta = 0;
    return delta;
  }

  /**
   * 取出并清空"快捷栏槽位发生切换"这一事件。
   *
   * @returns 新的槽位下标；本步没有切换时返回 `null`。
   */
  public consumeHotbarSlot(): number | null {
    const slot = this.#hotbarSlotChanged;
    this.#hotbarSlotChanged = null;
    return slot;
  }

  // -------------------------------------------------------------------------
  // 外部控制
  // -------------------------------------------------------------------------

  /**
   * 设置输入焦点。
   *
   * 关闭输入会清空按键状态与累积位移：UI 里按下的键不应该在关闭界面后继续生效。
   *
   * @param enabled - 焦点是否在游戏上。
   */
  public setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) {
      return;
    }
    this.#enabled = enabled;
    if (!enabled) {
      this.#clearTransientState();
    }
  }

  /** 显式设置暂停状态（指针锁定丢失时会自动设置）。 */
  public setPaused(paused: boolean): void {
    if (this.#paused === paused) {
      return;
    }
    this.#paused = paused;
    if (paused) {
      this.#clearTransientState();
    }
  }

  /** 请求指针锁定；浏览器要求该调用发生在用户手势内。 */
  public requestPointerLock(): void {
    if (this.#disposed) {
      return;
    }
    const element = this.#element;
    if (typeof element.requestPointerLock !== 'function') {
      // jsdom 与部分受限环境没有实现指针锁定；静默降级，游戏仍可用键盘测试。
      return;
    }
    // 现代浏览器返回 Promise：在"刚退出锁定后立刻重新请求"时会被拒绝，未处理的
    // rejection 会打印到控制台。`?.` 同时兼容仍返回 void 的旧实现。
    const request = element.requestPointerLock();
    void request?.catch(() => undefined);
  }

  /** 主动释放指针锁定（打开暂停菜单、切到后台时调用）。 */
  public exitPointerLock(): void {
    if (typeof document.exitPointerLock === 'function') {
      document.exitPointerLock();
    }
  }

  /**
   * 结束一个固定步：清空边沿集合与"本步累积"的事件。
   *
   * 必须在所有系统读取完输入之后调用，通常由游戏循环的 `onFixedStep` 末尾执行。
   */
  public endStep(): void {
    this.#pressed.clear();
    this.#released.clear();
    this.#wheelDelta = 0;
    this.#hotbarSlotChanged = null;
  }

  /**
   * 设置快捷栏槽位。
   *
   * 数字键与滚轮会自动调用它；UI 点击槽位时也应调用，保证两边状态一致。
   *
   * @param index - 槽位下标，超出范围时**环绕**（便于滚轮传任意整数）。
   */
  public setHotbarSlot(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }
    const wrapped = ((Math.trunc(index) % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
    if (wrapped === this.#hotbarSlot) {
      return;
    }
    this.#hotbarSlot = wrapped;
    this.#hotbarSlotChanged = wrapped;
  }

  /** 注销所有事件监听并释放指针锁定。幂等。 */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#detach();
    if (this.#pointerLocked) {
      this.exitPointerLock();
    }
    this.#pointerLocked = false;
    this.#clearTransientState();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 复位所有"瞬时"状态：按下集合、边沿集合、累积位移。 */
  #clearTransientState(): void {
    this.#down.clear();
    this.#pressed.clear();
    this.#released.clear();
    this.#lookDx = 0;
    this.#lookDy = 0;
    this.#wheelDelta = 0;
    this.#lookDragging = false;
    this.#primaryButtonDown = false;
  }

  #attach(): void {
    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onBlur);
    document.addEventListener('mousemove', this.#onMouseMove);
    document.addEventListener('pointerlockchange', this.#onPointerLockChange);
    this.#element.addEventListener('mousedown', this.#onMouseDown);
    this.#element.addEventListener('mouseup', this.#onMouseUp);
    // 必须显式声明非被动：否则无法阻止页面随滚轮滚动/缩放。
    this.#element.addEventListener('wheel', this.#onWheel, { passive: false });
    this.#element.addEventListener('contextmenu', this.#onContextMenu);
  }

  #detach(): void {
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);
    document.removeEventListener('mousemove', this.#onMouseMove);
    document.removeEventListener('pointerlockchange', this.#onPointerLockChange);
    this.#element.removeEventListener('mousedown', this.#onMouseDown);
    this.#element.removeEventListener('mouseup', this.#onMouseUp);
    this.#element.removeEventListener('wheel', this.#onWheel);
    this.#element.removeEventListener('contextmenu', this.#onContextMenu);
  }

  #isBindableTarget(target: EventTarget | null): boolean {
    // I. 输入框里的按键属于文本编辑，不是游戏操作。
    // 1. 新建世界要输入种子、设置界面要输入数值，没有这道判断时玩家打字会同时
    //    触发移动、切换快捷栏甚至跳跃。
    if (target === null) {
      return true;
    }
    if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) {
      return false;
    }
    if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) {
      return false;
    }
    if (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) {
      return false;
    }
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
      return !target.isContentEditable;
    }
    return true;
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (this.#disposed || !this.#isBindableTarget(event.target)) {
      return;
    }
    // 浏览器/系统快捷键（Ctrl+W、Cmd+Q、Alt+Tab）优先于游戏输入。
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const code = event.code;
    if (this.#boundCodes.has(code)) {
      // 空格与方向键会滚动页面，必须阻止默认行为；其余按键阻止也无副作用。
      event.preventDefault();
    }

    if (!event.repeat && !this.#down.has(code)) {
      this.#pressed.add(code);
    }
    this.#down.add(code);

    const digit = DIGIT_CODE_PATTERN.exec(code);
    if (digit !== null) {
      const value = digit[1];
      if (value !== undefined) {
        this.setHotbarSlot(Number.parseInt(value, 10) - 1);
      }
    }
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    if (this.#disposed) {
      return;
    }
    const code = event.code;
    if (this.#down.delete(code)) {
      this.#released.add(code);
    }
  };

  /** 失焦（切标签页、点开 devtools）时清空状态，避免"回来还在走"。 */
  #onBlur = (): void => {
    if (this.#disposed) {
      return;
    }
    this.#clearTransientState();
  };

  #onMouseDown = (event: MouseEvent): void => {
    if (this.#disposed) {
      return;
    }

    // 回退转向只在左键按住期间生效；`Mouse0` 同时仍作为 `attack` 动作上报，
    // 因此"按住左键挖掘"与"按住左键拖拽转向"是同一次按压的两个消费者。
    if (event.button === 0) {
      this.#primaryButtonDown = true;
      this.#lookDragging = !this.#pointerLocked;
    }

    const code = mouseCode(event.button);
    if (!this.#down.has(code)) {
      this.#pressed.add(code);
    }
    this.#down.add(code);
  };

  #onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) {
      this.#primaryButtonDown = false;
      this.#lookDragging = false;
    }

    if (this.#disposed) {
      return;
    }
    const code = mouseCode(event.button);
    if (this.#down.delete(code)) {
      this.#released.add(code);
    }
  };

  #onMouseMove = (event: MouseEvent): void => {
    if (this.#disposed || !this.#enabled || this.#paused) {
      return;
    }

    // I. 优先使用指针锁定下的裸位移。
    // II. 指针锁定不可用时回退到"按住左键拖拽转向"。
    // 1. 有些环境根本拿不到锁定：无焦点窗口、内嵌 iframe（被 `allow` 策略拒绝）、
    //    部分移动端浏览器。此前这些环境下鼠标完全无法转向 —— 第一人称游戏最重要
    //    的操作直接失效，而单元测试直接驱动 InputManager，浏览器测试又没有断言镜头
    //    旋转，所以缺陷一路漏到玩家手里。
    // 2. 拖拽是这类场景的标准回退：不需要锁定，也不会因为指针离开画布而丢失控制。
    const dragging = this.#lookDragging && this.#primaryButtonDown;
    if (!this.#pointerLocked && !dragging) {
      // 未锁定的自由移动属于玩家在操作 UI。
      return;
    }

    // 3. 非有限值必须挡在门外：远端桌面、录屏工具的合成事件可能给出 NaN，
    //    一旦写进相机角度就再也回不来。
    const dx = event.movementX;
    const dy = event.movementY;
    if (Number.isFinite(dx)) {
      this.#lookDx += dx;
    }
    if (Number.isFinite(dy)) {
      this.#lookDy += dy;
    }
  };

  #onWheel = (event: WheelEvent): void => {
    if (this.#disposed || !this.#enabled) {
      return;
    }
    if (Number.isFinite(event.deltaY) && event.deltaY !== 0) {
      this.#wheelDelta += event.deltaY;
      if (this.#scrollSelectsHotbar) {
        // 向下滚（deltaY > 0）选择下一个槽位，与 MC 一致。
        this.setHotbarSlot(this.#hotbarSlot + (event.deltaY > 0 ? 1 : -1));
      }
    }
    event.preventDefault();
  };

  /** 右键是"放置方块"，不能弹出浏览器上下文菜单。 */
  #onContextMenu = (event: MouseEvent): void => {
    if (this.#disposed || !this.#enabled) {
      return;
    }
    event.preventDefault();
  };

  #onPointerLockChange = (): void => {
    if (this.#disposed) {
      return;
    }
    const locked = document.pointerLockElement === this.#element;
    if (locked === this.#pointerLocked) {
      return;
    }
    this.#pointerLocked = locked;

    // I. 切换锁定状态时丢弃已累积的位移。
    // 1. 否则"暂停期间滑动鼠标 → 点回游戏"会把这段时间的位移一次性作用到视角上，
    //    表现为角色突然甩头。
    this.#lookDx = 0;
    this.#lookDy = 0;

    // II. 失去锁定即暂停。
    // 1. 玩家按 Esc 时浏览器不派发 Esc 的 keydown，只能靠这个事件；重新点击画面
    //    获得锁定时自动恢复，不需要额外的 UI 回调。
    this.setPaused(!locked);
    if (this.#pointerLockListener !== null) {
      this.#pointerLockListener(locked);
    }
  };
}

/** 鼠标键到物理码的映射：与键盘共用一个命名空间。 */
function mouseCode(button: number): string {
  return `Mouse${button}`;
}
