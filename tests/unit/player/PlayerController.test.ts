import { describe, expect, it } from 'vitest';

import { EventBus } from '@/engine/events/EventBus';
import type { InputAction, MoveIntent } from '@/input/InputManager';
import { isInsideSolid } from '@/physics/AABB';
import { createVec3, type Vec3 } from '@/physics/Vec3';
import { CameraRig, type RigCamera } from '@/player/CameraRig';
import {
  DEFAULT_MOVEMENT_TUNING,
  FIXED_TIME_STEP,
  idealJumpHeight,
  PlayerController,
  type PlayerInputSource,
  type PlayerWorld,
} from '@/player/PlayerController';
import { PLAYER_EYE_HEIGHT } from '@/player/Player';

/**
 * 手写的最小世界：地面方块与可选地形，外加区块坐标换算。
 *
 * `chunkOf` 与 `world/coords.ts` 的 `worldToChunkCoord` 保持同样的 `Math.floor`
 * 语义（负坐标向下取整），因此跨区块事件在负坐标下也成立。
 */
class FakeWorld implements PlayerWorld {
  readonly #blocks = new Set<string>();

  public set(x: number, y: number, z: number): this {
    this.#blocks.add(`${x},${y},${z}`);
    return this;
  }

  public fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): this {
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let z = z0; z <= z1; z += 1) {
          this.set(x, y, z);
        }
      }
    }
    return this;
  }

  public isSolidAt(x: number, y: number, z: number): boolean {
    if (y < 0) {
      return true;
    }
    return this.#blocks.has(`${x},${y},${z}`);
  }

  public chunkOf(x: number, z: number): { readonly cx: number; readonly cz: number } {
    return { cx: Math.floor(x / 16), cz: Math.floor(z / 16) };
  }
}

const NEUTRAL: MoveIntent = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  sneak: false,
};

/** 手写输入源：与 `InputManager` 的三个方法结构一致，但不接触 DOM。 */
class FakeInput implements PlayerInputSource {
  public intent: MoveIntent = { ...NEUTRAL };
  public readonly pressedActions = new Set<InputAction>();
  public lookDelta = { dx: 0, dy: 0 };

  public moveIntent(): MoveIntent {
    return this.intent;
  }

  public consumeLookDelta(): { readonly dx: number; readonly dy: number } {
    const delta = { dx: this.lookDelta.dx, dy: this.lookDelta.dy };
    this.lookDelta = { dx: 0, dy: 0 };
    return delta;
  }

  public wasActionPressed(action: InputAction): boolean {
    return this.pressedActions.has(action);
  }

  /** 模拟 `InputManager.endStep()`：清空一步内的边沿。 */
  public endStep(): void {
    this.pressedActions.clear();
  }

  public tap(action: InputAction): void {
    this.pressedActions.add(action);
  }
}

/** 一块平地：y = 0 一层方块，顶面 y = 1。 */
function flatWorld(): FakeWorld {
  return new FakeWorld().fill(-64, 0, -64, 64, 0, 64);
}

interface Harness {
  readonly world: FakeWorld;
  readonly input: FakeInput;
  readonly events: EventBus;
  readonly controller: PlayerController;
  step(count?: number): void;
}

function createHarness(
  world: FakeWorld,
  spawn: Vec3 = createVec3(0.5, 1, 0.5),
  options: { events?: EventBus; withInput?: boolean } = {},
): Harness {
  const input = new FakeInput();
  const events = options.events ?? new EventBus();
  const controller = new PlayerController({
    world,
    input: options.withInput === false ? null : input,
    events,
    spawn,
  });

  return {
    world,
    input,
    events,
    controller,
    step(count = 1): void {
      for (let index = 0; index < count; index += 1) {
        controller.update(FIXED_TIME_STEP);
        input.endStep();
      }
    },
  };
}

/** 让相机朝向 +X，便于在固定地形上测试移动。 */
function facePositiveX(controller: PlayerController): void {
  controller.cameraRig.setPose(-Math.PI / 2, 0);
}

describe('player/PlayerController 移动手感', () => {
  it('站在地面上：着地标志稳定，位置不漂移', () => {
    const harness = createHarness(flatWorld());
    harness.step(60);

    expect(harness.controller.onGround).toBe(true);
    expect(harness.controller.player.position.y).toBe(1);
    expect(harness.controller.horizontalSpeed).toBe(0);
  });

  it('按住前进在约 0.11 秒内加速到步行速度', () => {
    const harness = createHarness(flatWorld());
    facePositiveX(harness.controller);
    harness.input.intent = { ...NEUTRAL, forward: true };

    harness.step(3);
    // 40 格/秒² × 3/60 秒 = 2 格/秒。
    expect(harness.controller.horizontalSpeed).toBeCloseTo(2, 6);
    expect(harness.controller.horizontalSpeed).toBeLessThan(DEFAULT_MOVEMENT_TUNING.walkSpeed);

    harness.step(20);
    expect(harness.controller.horizontalSpeed).toBeCloseTo(DEFAULT_MOVEMENT_TUNING.walkSpeed, 6);
    // 沿 +X 移动，Z 不变。
    expect(harness.controller.player.position.z).toBeCloseTo(0.5, 6);
    expect(harness.controller.player.position.x).toBeGreaterThan(1);
  });

  it('松开按键后迅速减速到静止（地面摩擦）', () => {
    const harness = createHarness(flatWorld());
    facePositiveX(harness.controller);
    harness.input.intent = { ...NEUTRAL, forward: true };
    harness.step(30);
    expect(harness.controller.horizontalSpeed).toBeCloseTo(DEFAULT_MOVEMENT_TUNING.walkSpeed, 6);

    harness.input.intent = { ...NEUTRAL };
    harness.step(20);
    expect(harness.controller.horizontalSpeed).toBe(0);
  });

  it('疾跑更快，但必须同时按住前进', () => {
    const walking = createHarness(flatWorld());
    facePositiveX(walking.controller);
    walking.input.intent = { ...NEUTRAL, forward: true };
    walking.step(60);

    const sprinting = createHarness(flatWorld());
    facePositiveX(sprinting.controller);
    sprinting.input.intent = { ...NEUTRAL, forward: true, sprint: true };
    sprinting.step(60);

    expect(walking.controller.horizontalSpeed).toBeCloseTo(DEFAULT_MOVEMENT_TUNING.walkSpeed, 6);
    expect(sprinting.controller.horizontalSpeed).toBeCloseTo(
      DEFAULT_MOVEMENT_TUNING.sprintSpeed,
      6,
    );
    expect(sprinting.controller.player.sprinting).toBe(true);

    // 只按 Shift 不按前进：不疾跑。
    const shiftOnly = createHarness(flatWorld());
    shiftOnly.input.intent = { ...NEUTRAL, sprint: true };
    shiftOnly.step(10);
    expect(shiftOnly.controller.player.sprinting).toBe(false);
    expect(shiftOnly.controller.horizontalSpeed).toBe(0);
  });

  it('空中加速度明显弱于地面（空中难以急转）', () => {
    const ground = createHarness(flatWorld());
    facePositiveX(ground.controller);
    ground.input.intent = { ...NEUTRAL, forward: true };
    ground.step(3);
    const groundSpeed = ground.controller.horizontalSpeed;

    // 起跳后从静止开始加速：第一步只建立竖直速度，然后才有空中水平加速。
    const air = createHarness(flatWorld());
    facePositiveX(air.controller);
    air.input.tap('jump');
    air.step(1);
    expect(air.controller.onGround).toBe(false);

    air.input.intent = { ...NEUTRAL, forward: true };
    air.step(3);
    const airSpeed = air.controller.horizontalSpeed;

    expect(airSpeed).toBeCloseTo(0.4, 6);
    expect(airSpeed).toBeLessThan(groundSpeed / 3);
  });

  it('跳跃顶点约 1.28 格，足以越过 1 格台阶', () => {
    const harness = createHarness(flatWorld());
    const startY = harness.controller.player.position.y;

    harness.input.tap('jump');
    let apex = startY;
    for (let step = 0; step < 60; step += 1) {
      harness.step(1);
      apex = Math.max(apex, harness.controller.player.position.y);
    }

    // 实测 1.2844 格：连续模型 v²/2g = 1.21 格，离散积分因"先重力后跳跃覆盖"
    // 的次序略高。区间断言既能挡住"跳不上 1 格台阶"的回归，也不会因为一位小数
    // 的调参而误报。
    const height = apex - startY;
    expect(height).toBeGreaterThan(1.2);
    expect(height).toBeLessThan(1.35);
    expect(height).toBeGreaterThan(idealJumpHeight());
    // 落地后回到原高度并重新着地。
    expect(harness.controller.player.position.y).toBe(startY);
    expect(harness.controller.onGround).toBe(true);
  });

  it('跳跃可以上 1 格台阶；不跳则被台阶挡住（无自动上台阶）', () => {
    const plateau = new FakeWorld().fill(-64, 0, -64, 64, 0, 64).fill(2, 1, -64, 8, 1, 64);

    // I. 直接走：被 1 格高的台阶侧面挡住，位置停在 x = 2 - 0.3。
    const walker = createHarness(plateau, createVec3(1, 1, 0.5));
    facePositiveX(walker.controller);
    walker.input.intent = { ...NEUTRAL, forward: true };
    walker.step(120);

    expect(walker.controller.player.position.x).toBeCloseTo(2 - 0.3, 6);
    expect(walker.controller.player.position.y).toBe(1);
    expect(isInsideSolid(plateau, walker.controller.player.body)).toBe(false);

    // II. 起跳后可以落到台阶顶面并继续前进。
    const jumper = createHarness(plateau, createVec3(1, 1, 0.5));
    facePositiveX(jumper.controller);
    jumper.input.intent = { ...NEUTRAL, forward: true };
    jumper.input.tap('jump');

    let wasAirborne = false;
    for (let step = 0; step < 90; step += 1) {
      jumper.step(1);
      wasAirborne = wasAirborne || !jumper.controller.onGround;
    }

    expect(wasAirborne).toBe(true);
    expect(jumper.controller.player.position.y).toBe(2);
    expect(jumper.controller.player.position.x).toBeGreaterThan(2.5);
    expect(jumper.controller.onGround).toBe(true);
  });

  it('土狼时间：走出边缘后短时间内仍可起跳，超时后不行', () => {
    // 地面只到 x = 0，x > 0 是深坑。
    const ledge = new FakeWorld().fill(-64, 0, -64, 0, 0, 64);

    const within = createHarness(ledge, createVec3(-0.5, 1, 0.5));
    facePositiveX(within.controller);
    within.input.intent = { ...NEUTRAL, forward: true };
    let leftGround = false;
    for (let step = 0; step < 60 && !leftGround; step += 1) {
      within.step(1);
      leftGround = !within.controller.onGround;
    }
    expect(leftGround).toBe(true);

    within.input.tap('jump');
    within.step(1);
    expect(within.controller.player.velocity.y).toBeGreaterThan(0);

    // 超出窗口（0.10 秒 = 6 步）之后按键无效。
    const expired = createHarness(ledge, createVec3(-0.5, 1, 0.5));
    facePositiveX(expired.controller);
    expired.input.intent = { ...NEUTRAL, forward: true };
    for (let step = 0; step < 60 && expired.controller.onGround; step += 1) {
      expired.step(1);
    }
    expired.step(8);
    expired.input.tap('jump');
    expired.step(1);
    expect(expired.controller.player.velocity.y).toBeLessThanOrEqual(0);
  });

  it('跳跃缓冲：落地前按下的跳跃会在落地瞬间执行', () => {
    const harness = createHarness(flatWorld(), createVec3(0.5, 3.5, 0.5));

    let pressed = false;
    let apex = harness.controller.player.position.y;
    for (let step = 0; step < 90; step += 1) {
      // 接近地面的最后几帧才按下跳跃。
      if (!pressed && !harness.controller.onGround && harness.controller.player.position.y < 1.2) {
        harness.input.tap('jump');
        pressed = true;
      }
      harness.step(1);
      apex = Math.max(apex, harness.controller.player.position.y);
    }

    expect(pressed).toBe(true);
    // 落点在地面高度 1 之上重新起跳，顶点应显著高于 1.5。
    expect(apex).toBeGreaterThan(1.5);
  });

  it('按住 Space 会落地即再次起跳（连跳），松开后停止', () => {
    const harness = createHarness(flatWorld());
    harness.input.intent = { ...NEUTRAL, jump: true };

    let jumps = 0;
    let previousOnGround = true;
    let apex = harness.controller.player.position.y;
    for (let step = 0; step < 150; step += 1) {
      harness.step(1);
      const grounded = harness.controller.onGround;
      if (previousOnGround && !grounded) {
        jumps += 1;
      }
      previousOnGround = grounded;
      apex = Math.max(apex, harness.controller.player.position.y);
    }

    // 单次滞空约 0.55 秒（33 步），150 步内至少能跳 3 次。
    expect(jumps).toBeGreaterThanOrEqual(3);
    expect(apex - 1).toBeLessThan(1.35);

    harness.input.intent = { ...NEUTRAL };
    harness.step(60);
    expect(harness.controller.onGround).toBe(true);
  });

  it('落地时发出 player:landed，距离等于坠落高度', () => {
    const events = new EventBus();
    const distances: number[] = [];
    events.on('player:landed', (payload) => {
      distances.push(payload.distance);
    });

    const harness = createHarness(flatWorld(), createVec3(0.5, 5, 0.5), { events });
    harness.step(90);

    expect(distances).toEqual([4]);
    expect(harness.controller.onGround).toBe(true);
  });

  it('穿越区块边界时发出 player:chunk-changed', () => {
    const events = new EventBus();
    const chunks: { readonly cx: number; readonly cz: number }[] = [];
    events.on('player:chunk-changed', (payload) => {
      chunks.push({ cx: payload.cx, cz: payload.cz });
    });

    const harness = createHarness(flatWorld(), createVec3(15, 1, 0.5), { events });
    facePositiveX(harness.controller);
    harness.input.intent = { ...NEUTRAL, forward: true };
    harness.step(60);

    expect(chunks).toEqual([{ cx: 1, cz: 0 }]);
    expect(harness.controller.currentChunk).toEqual({ cx: 1, cz: 0 });
  });

  it('眼睛高度为 1.62，且相机跟随插值后的眼睛位置', () => {
    const harness = createHarness(flatWorld());
    facePositiveX(harness.controller);
    harness.input.intent = { ...NEUTRAL, forward: true };
    harness.step(30);

    expect(harness.controller.player.eyeY).toBeCloseTo(
      harness.controller.player.position.y + PLAYER_EYE_HEIGHT,
      10,
    );
    expect(harness.controller.eyePosition().y).toBeCloseTo(
      harness.controller.player.position.y + PLAYER_EYE_HEIGHT,
      10,
    );

    const camera: RigCamera & { position: { x: number; y: number; z: number } } = {
      position: {
        x: 0,
        y: 0,
        z: 0,
        set(x: number, y: number, z: number): void {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      },
      rotation: {
        order: 'XYZ',
        set(): void {
          // 朝向断言由 CameraRig 的单测覆盖，这里只关心位置。
        },
      },
      fov: 75,
      updateProjectionMatrix(): void {
        // 无 WebGL 环境：不需要真的重建投影矩阵。
      },
    };

    harness.controller.applyCamera(camera, 1);
    expect(camera.rotation.order).toBe('YXZ');
    // 相机位置 = 插值后的眼睛位置 + 走路摇晃偏移。
    expect(camera.position.x).toBeCloseTo(
      harness.controller.player.position.x + harness.controller.cameraRig.bobOffset.x,
      6,
    );
    expect(camera.position.y).toBeCloseTo(
      harness.controller.eyePosition().y + harness.controller.cameraRig.bobOffset.y,
      6,
    );
  });

  it('传送会解除与地形的重叠并同步区块', () => {
    const events = new EventBus();
    const chunks: number[] = [];
    events.on('player:chunk-changed', (payload) => {
      chunks.push(payload.cx);
    });

    const harness = createHarness(flatWorld(), createVec3(0.5, 1, 0.5), { events });
    // 目标位置落在实体方块内部（y = 0 层），必须被推出来。
    harness.controller.teleport(createVec3(20.5, 0.5, 0.5));

    expect(isInsideSolid(harness.world, harness.controller.player.body)).toBe(false);
    expect(harness.controller.player.position.y).toBe(1);
    expect(chunks).toEqual([1]);
  });

  it('鼠标位移通过相机机架生效，视野打开时由输入层保证为零', () => {
    const harness = createHarness(flatWorld());
    harness.input.lookDelta = { dx: 100, dy: -50 };
    harness.step(1);

    // 灵敏度 0.0022（默认）→ yaw 减小 0.22，pitch 增大 0.11。
    expect(harness.controller.cameraRig.yaw).toBeCloseTo(-0.22, 6);
    expect(harness.controller.cameraRig.pitch).toBeCloseTo(0.11, 6);

    // 读取后位移被清零，不重复作用。
    harness.step(1);
    expect(harness.controller.cameraRig.yaw).toBeCloseTo(-0.22, 6);
  });

  it('相同输入序列得到完全相同的轨迹（固定步长可复现）', () => {
    const run = (): number[] => {
      const harness = createHarness(flatWorld(), createVec3(0.5, 3, 0.5));
      facePositiveX(harness.controller);
      harness.input.intent = { ...NEUTRAL, forward: true };
      harness.input.tap('jump');
      const trace: number[] = [];
      for (let step = 0; step < 120; step += 1) {
        harness.step(1);
        trace.push(
          harness.controller.player.position.x,
          harness.controller.player.position.y,
          harness.controller.player.position.z,
        );
      }
      return trace;
    };

    expect(run()).toEqual(run());
  });

  it('没有输入源时玩家仍然受重力并停在地面上', () => {
    const harness = createHarness(flatWorld(), createVec3(0.5, 3, 0.5), { withInput: false });
    harness.step(90);

    expect(harness.controller.onGround).toBe(true);
    expect(harness.controller.player.position.y).toBe(1);
    expect(harness.controller.horizontalSpeed).toBe(0);
  });

  it('潜行时速度更低', () => {
    const harness = createHarness(flatWorld());
    facePositiveX(harness.controller);
    harness.input.intent = { ...NEUTRAL, forward: true, sneak: true };
    harness.step(60);

    expect(harness.controller.horizontalSpeed).toBeCloseTo(DEFAULT_MOVEMENT_TUNING.sneakSpeed, 6);
    expect(harness.controller.player.sneaking).toBe(true);
  });

  it('撞墙时对应轴的速度被清零，不会累积成弹射', () => {
    const wall = flatWorld().fill(3, 1, -64, 3, 3, 64);
    const harness = createHarness(wall, createVec3(0.5, 1, 0.5));
    facePositiveX(harness.controller);
    harness.input.intent = { ...NEUTRAL, forward: true };
    harness.step(120);

    expect(harness.controller.player.position.x).toBeCloseTo(3 - 0.3, 6);
    expect(harness.controller.player.velocity.x).toBe(0);
    expect(isInsideSolid(wall, harness.controller.player.body)).toBe(false);
  });

  it('相机机架可由外部注入，设置可以即时更新', () => {
    const rig = new CameraRig();
    const controller = new PlayerController({
      world: flatWorld(),
      cameraRig: rig,
      spawn: createVec3(0.5, 1, 0.5),
    });

    controller.setSettings({ mouseSensitivity: 0.004, fov: 90, invertY: true, viewBobbing: false });

    expect(controller.cameraRig).toBe(rig);
    expect(rig.fov).toBe(90);
  });
});
