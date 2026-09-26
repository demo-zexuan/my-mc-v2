// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InputManager } from '@/input/InputManager';

/** 按下的按键事件；默认派发到 window（与真实页面一致）。 */
function pressKey(code: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, ...init }));
}

function releaseKey(code: string, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

/**
 * 构造鼠标移动事件。
 *
 * jsdom 的 `MouseEventInit` 不接受 `movementX/MovementY`，因此用 `defineProperty`
 * 在实例上盖一个同名属性。
 */
function moveMouse(dx: number, dy: number, target: EventTarget = document): void {
  const event = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(event, 'movementX', { value: dx });
  Object.defineProperty(event, 'movementY', { value: dy });
  target.dispatchEvent(event);
}

function pressMouse(button: number, target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
}

function releaseMouse(button: number, target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
}

/** 模拟浏览器在指针锁定状态切换时派发的事件。 */
function setPointerLockElement(element: Element | null): void {
  Object.defineProperty(document, 'pointerLockElement', {
    configurable: true,
    get: () => element,
  });
  document.dispatchEvent(new Event('pointerlockchange'));
}

describe('input/InputManager', () => {
  let element: HTMLDivElement;
  let input: InputManager;

  beforeEach(() => {
    document.body.innerHTML = '';
    element = document.createElement('div');
    document.body.append(element);
    setPointerLockElement(null);
    input = new InputManager({ element });
  });

  afterEach(() => {
    input.dispose();
  });

  it('记录按下、步内边沿与释放', () => {
    pressKey('KeyW');
    expect(input.isDown('KeyW')).toBe(true);
    expect(input.wasPressed('KeyW')).toBe(true);
    expect(input.moveIntent().forward).toBe(true);

    // 结束一步后：仍然按住，但"刚按下"消失。
    input.endStep();
    expect(input.wasPressed('KeyW')).toBe(false);
    expect(input.isDown('KeyW')).toBe(true);

    releaseKey('KeyW');
    expect(input.wasReleased('KeyW')).toBe(true);
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.moveIntent().forward).toBe(false);
  });

  it('系统重复按键（repeat）不会重复产生"刚按下"', () => {
    pressKey('Space');
    input.endStep();

    pressKey('Space', { repeat: true });
    expect(input.wasPressed('Space')).toBe(false);
    expect(input.isDown('Space')).toBe(true);
  });

  it('移动意图覆盖 WASD、Shift、Space 与方向键别名', () => {
    pressKey('KeyA');
    pressKey('ArrowUp');
    pressKey('ShiftLeft');
    pressKey('Space');

    expect(input.moveIntent()).toEqual({
      forward: true,
      back: false,
      left: true,
      right: false,
      jump: true,
      sprint: true,
      sneak: false,
    });
  });

  it('UI 打开（setEnabled(false)）时不产生移动意图，并清空残留按键', () => {
    pressKey('KeyW');
    input.setEnabled(false);

    expect(input.moveIntent().forward).toBe(false);
    expect(input.isDown('KeyW')).toBe(false);

    // 关闭 UI 后按键状态不会"复活"。
    input.setEnabled(true);
    expect(input.moveIntent().forward).toBe(false);
  });

  it('暂停时不产生移动意图，恢复后需要重新按键（避免"回来还在走"）', () => {
    pressKey('KeyW');
    input.setPaused(true);
    expect(input.moveIntent().forward).toBe(false);
    // 暂停即清空按键状态：否则恢复游戏的瞬间角色会继续向前冲。
    expect(input.isDown('KeyW')).toBe(false);

    input.setPaused(false);
    expect(input.moveIntent().forward).toBe(false);

    pressKey('KeyW');
    expect(input.moveIntent().forward).toBe(true);
  });

  it('失去指针锁定自动暂停，重新锁定自动恢复（Esc 不派发 keydown）', () => {
    const states: boolean[] = [];
    input.dispose();
    input = new InputManager({
      element,
      onPointerLockChange: (locked) => states.push(locked),
    });

    setPointerLockElement(element);
    expect(input.pointerLocked).toBe(true);
    expect(input.paused).toBe(false);

    // 玩家按 Esc：浏览器只解除锁定并派发 pointerlockchange。
    setPointerLockElement(null);
    expect(input.pointerLocked).toBe(false);
    expect(input.paused).toBe(true);
    expect(states).toEqual([true, false]);

    setPointerLockElement(element);
    expect(input.paused).toBe(false);
  });

  it('鼠标位移只在锁定时累积，读取后清零', () => {
    moveMouse(12, -4);
    expect(input.consumeLookDelta()).toEqual({ dx: 0, dy: 0 });

    setPointerLockElement(element);
    moveMouse(12, -4);
    moveMouse(3, 1);
    expect(input.consumeLookDelta()).toEqual({ dx: 15, dy: -3 });
    expect(input.consumeLookDelta()).toEqual({ dx: 0, dy: 0 });
  });

  it('忽略非有限的鼠标位移（远端桌面可能给出 NaN）', () => {
    setPointerLockElement(element);
    moveMouse(Number.NaN, 5);

    expect(input.consumeLookDelta()).toEqual({ dx: 0, dy: 5 });
  });

  it('切换锁定状态时丢弃暂停期间累积的位移', () => {
    moveMouse(100, 100); // 未锁定，不累积
    setPointerLockElement(element);
    expect(input.consumeLookDelta()).toEqual({ dx: 0, dy: 0 });
  });

  it('滚轮累积量按步清空，并切换快捷栏槽位', () => {
    element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
    );

    expect(input.consumeWheelDelta()).toBe(120);
    expect(input.hotbarSlot).toBe(1);
    expect(input.consumeHotbarSlot()).toBe(1);
    expect(input.consumeHotbarSlot()).toBeNull();

    input.endStep();
    expect(input.consumeWheelDelta()).toBe(0);

    // 向上滚回到 0，再向上滚环绕到最后一个槽位。
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    expect(input.hotbarSlot).toBe(0);
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    expect(input.hotbarSlot).toBe(8);
  });

  it('数字键 1-9 选择槽位，0 不生效', () => {
    pressKey('Digit3');
    expect(input.hotbarSlot).toBe(2);
    expect(input.consumeHotbarSlot()).toBe(2);

    pressKey('Digit9');
    expect(input.hotbarSlot).toBe(8);

    pressKey('Digit0');
    expect(input.hotbarSlot).toBe(8);
  });

  it('setHotbarSlot 对越界值环绕并对非法值静默忽略', () => {
    input.setHotbarSlot(11);
    expect(input.hotbarSlot).toBe(2);

    input.setHotbarSlot(-1);
    expect(input.hotbarSlot).toBe(8);

    input.setHotbarSlot(Number.NaN);
    expect(input.hotbarSlot).toBe(8);
  });

  it('Esc 映射到 pause 动作', () => {
    pressKey('Escape');
    expect(input.wasActionPressed('pause')).toBe(true);
    expect(input.isActionDown('pause')).toBe(true);
  });

  it('鼠标键映射为 attack / use / pick 动作', () => {
    pressMouse(0, element);
    pressMouse(2, element);
    pressMouse(1, element);

    expect(input.wasActionPressed('attack')).toBe(true);
    expect(input.wasActionPressed('use')).toBe(true);
    expect(input.wasActionPressed('pick')).toBe(true);

    releaseMouse(0, element);
    expect(input.wasActionReleased('attack')).toBe(true);
    expect(input.isActionDown('attack')).toBe(false);
  });

  it('输入框（新建世界种子、设置数值）中的按键不进入游戏输入', () => {
    const field = document.createElement('input');
    document.body.append(field);

    pressKey('KeyW', {}, field);
    pressKey('Digit3', {}, field);
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.moveIntent().forward).toBe(false);
    expect(input.hotbarSlot).toBe(0);
  });

  it('窗口失焦会清空按键状态', () => {
    pressKey('KeyW');
    window.dispatchEvent(new Event('blur'));

    expect(input.isDown('KeyW')).toBe(false);
    expect(input.moveIntent().forward).toBe(false);
  });

  it('按住 Ctrl / Meta 的组合键不进入游戏输入', () => {
    pressKey('KeyW', { ctrlKey: true });
    pressKey('KeyA', { metaKey: true });

    expect(input.isDown('KeyW')).toBe(false);
    expect(input.isDown('KeyA')).toBe(false);
  });

  it('自定义键位生效', () => {
    input.dispose();
    input = new InputManager({ element, bindings: { forward: ['KeyI'] } });

    pressKey('KeyI');
    expect(input.moveIntent().forward).toBe(true);
    pressKey('KeyW');
    expect(input.isDown('KeyW')).toBe(true); // 仍然记录按键，但不再映射到 forward
    expect(input.moveIntent().forward).toBe(true);
  });

  it('缺少 requestPointerLock 实现时静默降级，不抛错', () => {
    expect(() => {
      input.requestPointerLock();
      input.exitPointerLock();
    }).not.toThrow();
  });

  it('requestPointerLock 的 Promise 拒绝不会变成未处理异常', async () => {
    const target = element as HTMLElement & { requestPointerLock: () => Promise<void> };
    target.requestPointerLock = () => Promise.reject(new Error('denied'));

    expect(() => {
      input.requestPointerLock();
    }).not.toThrow();
    // 让微任务队列排空，未捕获的 rejection 会让测试失败。
    await Promise.resolve();
  });

  it('dispose 之后不再响应事件，且可重复调用', () => {
    input.dispose();
    pressKey('KeyW');
    expect(input.isDown('KeyW')).toBe(false);

    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    expect(input.consumeWheelDelta()).toBe(0);

    expect(() => {
      input.dispose();
    }).not.toThrow();
  });
});
