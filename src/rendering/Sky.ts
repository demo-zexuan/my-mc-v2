/**
 * 天空与昼夜循环。
 *
 * I. 分层：纯数据 / 场景对象
 *
 * 1. `DayNightCycle` 只做时间推进与采样，输出一个纯数据 `SkyState`（相位、太阳方向、
 *    天空色、雾色、光强）。它不碰 Three.js 的场景图，因此可以用单测断言"t=0.5 时太阳
 *    在正上方、强度最大"这类确定性结论。
 * 2. `Sky` 才负责把状态写进场景：渐变天穹（ShaderMaterial）、太阳与月亮、云层，以及
 *    雾颜色插值。`syncEnvironment()` 把同一个状态写进 `Environment` 的平行光与半球光，
 *    于是昼夜、雾、光照三者永远来自同一份采样结果，不会各自漂移。
 *
 * II. 时间表示
 *
 * 1. `timeOfDay ∈ [0, 1)`：0 是午夜，0.25 是日出，0.5 是正午，0.75 是日落。
 * 2. 太阳方向由高度角推导：`a = (t - 0.25) * 2π`，`elevation = sin(a)`。
 *    为了让日出方位不那么"正东正西"，整条轨迹绕 Y 轴固定旋转一个方位角，但正午依然
 *    严格指向 +Y（测试与阴影方向都依赖这一点）。
 * 3. 相位由高度角阈值决定（dawn/day/dusk/night），而不是写死的时间区间：只要太阳在
 *    地平线附近，就是黎明或黄昏，改了 `dayLengthSeconds` 也不会出现相位与光照不一致。
 *
 * III. 为什么天穹是 ShaderMaterial 而不是贴图
 *
 * 1. 渐变天空只需要两个颜色 uniform 与一个高度插值，比生成 6 张立方体贴图便宜得多，
 *    而且能随昼夜连续变化，不需要任何资源。
 * 2. 云层同样用片元噪声生成：不占显存、不需要 canvas，滚动完全由 uniform 驱动。
 *
 * @module rendering/Sky
 */

import * as THREE from 'three';

import type { EnvironmentRig } from './Environment';

/** 太阳升起的时刻（`timeOfDay`）。 */
export const SUNRISE = 0.25;
/** 太阳落下的时刻（`timeOfDay`）。 */
export const SUNSET = 0.75;

/** 白天判定用的高度角阈值：高于它才算"白天"。 */
const DAY_ELEVATION_THRESHOLD = 0.15;
/**
 * 地平线判定的浮点容差。
 *
 * `Math.sin( Math.PI )` 得到的是 1.22e-16 而不是 0：没有容差的话，日落那一刻会被判成
 * "黄昏中"、而对称的日出那一刻却被判成"夜晚"。容差取 1e-6，相当于不到一秒的游戏时间。
 */
const HORIZON_EPSILON = 1e-6;
/** 太阳轨迹绕 Y 轴的整体方位角（弧度），让日出/日落不在正东正西。 */
const DEFAULT_AZIMUTH = Math.PI / 7;
/** 默认一天的长度（秒）。 */
const DEFAULT_DAY_LENGTH = 1200;

const TAU = Math.PI * 2;

/** 昼夜相位。 */
export type SkyPhase = 'night' | 'dawn' | 'day' | 'dusk';

/**
 * 场景雾的最小结构视图。
 *
 * `THREE.Fog` 与 `THREE.FogExp2` 只共用 `color` 字段，这里只依赖这一点：天空不需要
 * 关心项目最终选用哪一种雾，也不需要在类型层面导入具体的雾类。
 */
export interface FogLike {
  readonly color: THREE.Color;
}

/** 采样出来的天空状态；方向与颜色对象会被复用，调用方不应长期持有。 */
export interface SkyState {
  /** 采样时刻，`[0, 1)`。 */
  timeOfDay: number;
  phase: SkyPhase;
  /** 太阳方向（单位向量，+Y 为正上方）。 */
  readonly sunDirection: THREE.Vector3;
  /** 月亮方向，等于太阳方向取反。 */
  readonly moonDirection: THREE.Vector3;
  readonly sunColor: THREE.Color;
  readonly zenithColor: THREE.Color;
  readonly horizonColor: THREE.Color;
  readonly fogColor: THREE.Color;
  readonly cloudColor: THREE.Color;
  /** 平行光强度（太阳在地平线以上时使用）。 */
  sunIntensity: number;
  /** 月光强度（太阳在地平线以下时使用）。 */
  moonIntensity: number;
  /** 半球光（环境项）强度。 */
  ambientIntensity: number;
  /** 云层不透明度。 */
  cloudOpacity: number;
}

/** 一个关键帧；相邻关键帧之间线性插值。 */
interface SkyKeyframe {
  readonly t: number;
  readonly zenith: number;
  readonly horizon: number;
  readonly fog: number;
  readonly sun: number;
  readonly cloud: number;
  readonly sunIntensity: number;
  readonly moonIntensity: number;
  readonly ambientIntensity: number;
  readonly cloudOpacity: number;
}

/**
 * 昼夜调色板。
 *
 * `t = 1` 与 `t = 0` 必须完全一致，否则一天结束时天空会跳变。
 */
const KEYFRAMES: readonly SkyKeyframe[] = [
  {
    t: 0,
    zenith: 0x05070f,
    horizon: 0x0b1220,
    fog: 0x0a0f18,
    sun: 0x9fb6e0,
    cloud: 0x2b3550,
    sunIntensity: 0.04,
    moonIntensity: 0.24,
    ambientIntensity: 0.3,
    cloudOpacity: 0.25,
  },
  {
    t: SUNRISE,
    zenith: 0x2a3f6b,
    horizon: 0xe08a4a,
    fog: 0xc08a5e,
    sun: 0xffb066,
    cloud: 0xf0b088,
    sunIntensity: 0.95,
    moonIntensity: 0.05,
    ambientIntensity: 0.55,
    cloudOpacity: 0.55,
  },
  {
    t: 0.5,
    zenith: 0x4a8fd4,
    horizon: 0xa8cdf0,
    fog: 0xbcd8f2,
    sun: 0xfff3d6,
    cloud: 0xffffff,
    sunIntensity: 2.2,
    moonIntensity: 0,
    ambientIntensity: 0.85,
    cloudOpacity: 0.7,
  },
  {
    t: SUNSET,
    zenith: 0x27406e,
    horizon: 0xd8743c,
    fog: 0xa8683f,
    sun: 0xff9a4d,
    cloud: 0xe89a72,
    sunIntensity: 0.85,
    moonIntensity: 0.05,
    ambientIntensity: 0.5,
    cloudOpacity: 0.55,
  },
  {
    t: 1,
    zenith: 0x05070f,
    horizon: 0x0b1220,
    fog: 0x0a0f18,
    sun: 0x9fb6e0,
    cloud: 0x2b3550,
    sunIntensity: 0.04,
    moonIntensity: 0.24,
    ambientIntensity: 0.3,
    cloudOpacity: 0.25,
  },
];

/** 月光颜色；夜晚的平行光方向取月亮方向，颜色单独指定以免继承日落的暖色。 */
const MOON_LIGHT_COLOR = new THREE.Color(0xaec6ff);

/**
 * 地面反弹的反照率。
 *
 * 半球光的"地面项"代表从地面反射回天空的光：它是地平线色乘以地表反照率，而不是一个
 * 固定的暗棕色。三个分量都在 1 以下且偏暖，用来近似被草地、泥土吸收后的暖色光。
 */
const GROUND_BOUNCE = new THREE.Color(0.3, 0.27, 0.22);

/**
 * 与法线无关的环境光占白天环境强度的比例。
 *
 * 0.22 是"树叶底面在白天读作深绿而不是纯黑"的下限附近：再小就会在阴影里回到接近黑色，
 * 再大则会把夜景点亮成灰色、削弱平行光的明暗对比（单测里用"朝上/朝下的亮度比 ≥ 1.3"钉住）。
 */
const AMBIENT_FLOOR_RATIO = 0.22;

/** 关键帧颜色对象缓存，避免每次采样都构造 `THREE.Color`。 */
const KEYFRAME_COLORS: readonly {
  readonly zenith: THREE.Color;
  readonly horizon: THREE.Color;
  readonly fog: THREE.Color;
  readonly sun: THREE.Color;
  readonly cloud: THREE.Color;
}[] = KEYFRAMES.map((frame) => ({
  zenith: new THREE.Color(frame.zenith),
  horizon: new THREE.Color(frame.horizon),
  fog: new THREE.Color(frame.fog),
  sun: new THREE.Color(frame.sun),
  cloud: new THREE.Color(frame.cloud),
}));

/** 把任意实数折算进 `[0, 1)`。 */
function wrapTime(value: number): number {
  const wrapped = value % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

/** 线性插值。 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 根据时刻判定相位。 */
export function phaseAt(timeOfDay: number): SkyPhase {
  const angle = (wrapTime(timeOfDay) - SUNRISE) * TAU;
  const elevation = Math.sin(angle);
  if (elevation > DAY_ELEVATION_THRESHOLD) {
    return 'day';
  }
  if (elevation <= HORIZON_EPSILON) {
    return 'night';
  }
  // 高度角为正但不高：上升段是黎明，下降段是黄昏。
  return Math.cos(angle) >= 0 ? 'dawn' : 'dusk';
}

/** 新建一个可写的天空状态缓冲。 */
export function createSkyState(): SkyState {
  return {
    timeOfDay: 0,
    phase: 'night',
    sunDirection: new THREE.Vector3(0, 1, 0),
    moonDirection: new THREE.Vector3(0, -1, 0),
    sunColor: new THREE.Color(),
    zenithColor: new THREE.Color(),
    horizonColor: new THREE.Color(),
    fogColor: new THREE.Color(),
    cloudColor: new THREE.Color(),
    sunIntensity: 0,
    moonIntensity: 0,
    ambientIntensity: 0,
    cloudOpacity: 0,
  };
}

/**
 * 采样某个时刻的天空状态。
 *
 * @param timeOfDay - 时刻，任意实数（内部折算进 `[0, 1)`）。
 * @param target - 复用的输出缓冲；省略时新建一个。
 * @param azimuth - 太阳轨迹的方位角（弧度）。
 * @returns 采样结果（即 `target`）。
 */
export function sampleSkyState(
  timeOfDay: number,
  target: SkyState = createSkyState(),
  azimuth: number = DEFAULT_AZIMUTH,
): SkyState {
  const t = wrapTime(timeOfDay);

  // I. 定位关键帧区间。
  // 1. 关键帧覆盖 [0, 1]，默认落在最后一段，向前查找第一个"右端点不小于 t"的区间。
  let index = KEYFRAMES.length - 2;
  for (let i = 0; i < KEYFRAMES.length - 1; i += 1) {
    const next = KEYFRAMES[i + 1];
    if (next !== undefined && t <= next.t) {
      index = i;
      break;
    }
  }

  const from = KEYFRAMES[index];
  const to = KEYFRAMES[index + 1] ?? KEYFRAMES[KEYFRAMES.length - 1];
  const fromColors = KEYFRAME_COLORS[index];
  const toColors = KEYFRAME_COLORS[Math.min(index + 1, KEYFRAME_COLORS.length - 1)];
  if (
    from === undefined ||
    to === undefined ||
    fromColors === undefined ||
    toColors === undefined
  ) {
    return target;
  }

  const span = to.t - from.t;
  const blend = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - from.t) / span));

  // I. 颜色与标量：全部在关键帧之间线性插值。
  target.timeOfDay = t;
  target.phase = phaseAt(t);
  target.zenithColor.copy(fromColors.zenith).lerp(toColors.zenith, blend);
  target.horizonColor.copy(fromColors.horizon).lerp(toColors.horizon, blend);
  target.fogColor.copy(fromColors.fog).lerp(toColors.fog, blend);
  target.sunColor.copy(fromColors.sun).lerp(toColors.sun, blend);
  target.cloudColor.copy(fromColors.cloud).lerp(toColors.cloud, blend);
  target.sunIntensity = lerp(from.sunIntensity, to.sunIntensity, blend);
  target.moonIntensity = lerp(from.moonIntensity, to.moonIntensity, blend);
  target.ambientIntensity = lerp(from.ambientIntensity, to.ambientIntensity, blend);
  target.cloudOpacity = lerp(from.cloudOpacity, to.cloudOpacity, blend);

  // II. 方向：高度角 0 对应日出，π/2 对应正午。
  const angle = (t - SUNRISE) * TAU;
  const horizontal = Math.cos(angle);
  target.sunDirection
    .set(horizontal * Math.cos(azimuth), Math.sin(angle), horizontal * Math.sin(azimuth))
    .normalize();
  target.moonDirection.copy(target.sunDirection).negate();

  return target;
}

export interface DayNightCycleOptions {
  /** 一天的长度（秒）。默认 1200（20 分钟）。 */
  readonly dayLengthSeconds?: number;
  /** 起始时刻，默认 0.3（清晨，太阳已经升起）。 */
  readonly startTime?: number;
  /** 是否暂停时间推进。 */
  readonly paused?: boolean;
  /** 太阳轨迹方位角（弧度）。 */
  readonly azimuth?: number;
}

/**
 * 昼夜时间推进器。
 *
 * 状态按需采样到内部缓冲，因此每帧只产生零分配：方向与颜色对象都是复用的。
 */
export class DayNightCycle {
  readonly #state = createSkyState();
  #time: number;
  #paused: boolean;
  #azimuth: number;

  public dayLengthSeconds: number;

  public constructor(options: DayNightCycleOptions = {}) {
    this.dayLengthSeconds = Math.max(1, options.dayLengthSeconds ?? DEFAULT_DAY_LENGTH);
    this.#time = wrapTime(options.startTime ?? 0.3);
    this.#paused = options.paused ?? false;
    this.#azimuth = options.azimuth ?? DEFAULT_AZIMUTH;
  }

  /** 当前时刻，`[0, 1)`。 */
  public get timeOfDay(): number {
    return this.#time;
  }

  public get paused(): boolean {
    return this.#paused;
  }

  public set paused(value: boolean) {
    this.#paused = value;
  }

  public get azimuth(): number {
    return this.#azimuth;
  }

  public set azimuth(value: number) {
    this.#azimuth = value;
  }

  /** 当前相位。 */
  public get phase(): SkyPhase {
    return phaseAt(this.#time);
  }

  /** 当前天空状态（复用缓冲，读取时即时采样）。 */
  public get state(): SkyState {
    return sampleSkyState(this.#time, this.#state, this.#azimuth);
  }

  /** 直接设置时刻；超出 `[0, 1)` 会被折算。 */
  public setTime(value: number): void {
    this.#time = wrapTime(value);
  }

  /**
   * 推进时间。
   *
   * @param deltaSeconds - 经过的秒数；非有限值会被忽略（例如帧间隔统计异常）。
   */
  public advance(deltaSeconds: number): void {
    if (this.#paused || !Number.isFinite(deltaSeconds)) {
      return;
    }
    this.#time = wrapTime(this.#time + deltaSeconds / this.dayLengthSeconds);
  }
}

export interface SkyOptions {
  /** 天穹半径。必须小于相机远平面，否则整个天空会被裁掉。默认 400。 */
  readonly radius?: number;
  /** 云层所在的世界高度。默认 150（世界最高方块在 y=127 之上）。 */
  readonly cloudHeight?: number;
  /** 云层平面边长。默认 4000。 */
  readonly cloudSize?: number;
  /** 云噪声密度。默认 6。 */
  readonly cloudScale?: number;
  /** 时间推进器；省略时按默认参数新建。 */
  readonly cycle?: DayNightCycle;
}

const DOME_VERTEX_SHADER = /* glsl */ `varying vec3 vSkyDirection;

void main() {
	vSkyDirection = normalize( position );
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const DOME_FRAGMENT_SHADER = /* glsl */ `uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;
uniform float uSunIntensity;

varying vec3 vSkyDirection;

void main() {
	vec3 direction = normalize( vSkyDirection );

	// I. 高度渐变：地平线附近取地平线色，天顶取天顶色。
	float height = clamp( direction.y * 0.5 + 0.5, 0.0, 1.0 );
	vec3 sky = mix( uHorizonColor, uZenithColor, pow( height, 0.6 ) );

	// II. 太阳辉光：宽晕染 + 窄日面，两者叠加出日出时整条地平线发红的效果。
	float sunAmount = max( dot( direction, uSunDirection ), 0.0 );
	sky += uSunColor * uSunIntensity * ( pow( sunAmount, 12.0 ) * 0.18 + pow( sunAmount, 200.0 ) * 1.1 );

	// III. 地平线以下压暗，避免俯视洞穴时看到亮蓝色的"地下天空"。
	sky *= mix( 0.45, 1.0, smoothstep( -0.08, 0.14, direction.y ) );

	gl_FragColor = vec4( sky, 1.0 );

	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

const CLOUD_VERTEX_SHADER = /* glsl */ `varying vec2 vCloudUv;

void main() {
	vCloudUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `uniform vec3 uCloudColor;
uniform float uOpacity;
uniform float uTime;
uniform float uScale;

varying vec2 vCloudUv;

float hash21( vec2 p ) {
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 45.32 );
	return fract( p.x * p.y );
}

float valueNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = hash21( i );
	float b = hash21( i + vec2( 1.0, 0.0 ) );
	float c = hash21( i + vec2( 0.0, 1.0 ) );
	float d = hash21( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

float fbm( vec2 p ) {
	float total = 0.0;
	float amplitude = 0.5;
	for ( int i = 0; i < 4; i ++ ) {
		total += valueNoise( p ) * amplitude;
		p *= 2.03;
		amplitude *= 0.5;
	}
	return total;
}

void main() {
	vec2 p = vCloudUv * uScale + vec2( uTime * 0.02, uTime * 0.006 );
	float density = fbm( p );
	float mask = smoothstep( 0.5, 0.78, density );

	// 平面边缘淡出，否则云层会在远处出现一条直边。
	vec2 edge = smoothstep( vec2( 0.0 ), vec2( 0.12 ), vCloudUv ) *
		smoothstep( vec2( 1.0 ), vec2( 0.88 ), vCloudUv );
	float alpha = mask * uOpacity * edge.x * edge.y;
	if ( alpha < 0.004 ) {
		discard;
	}

	gl_FragColor = vec4( uCloudColor, alpha );

	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/**
 * 天空、太阳、月亮、云层与雾的持有者。
 *
 * 天穹、太阳与月亮挂在一个跟随相机的组里（永远包围视角），云层则固定在世界的某个
 * 高度上、只跟随相机的水平位置，因此抬头看云时不会觉得云在跟着自己跑。
 */
export class Sky {
  /** 时间推进器；调用方也可以传自己的实例进来。 */
  public readonly cycle: DayNightCycle;

  /** 跟随相机的天空组（天穹 + 太阳 + 月亮）。 */
  public readonly group: THREE.Group;
  /** 云层组（只跟随水平位置）。 */
  public readonly cloudGroup: THREE.Group;

  readonly #scene: THREE.Scene;
  readonly #sunMesh: THREE.Mesh;
  readonly #moonMesh: THREE.Mesh;
  readonly #domeMaterial: THREE.ShaderMaterial;
  readonly #cloudMaterial: THREE.ShaderMaterial;
  readonly #uniformes: {
    readonly zenith: THREE.IUniform<THREE.Color>;
    readonly horizon: THREE.IUniform<THREE.Color>;
    readonly sunColor: THREE.IUniform<THREE.Color>;
    readonly sunDirection: THREE.IUniform<THREE.Vector3>;
    readonly sunIntensity: THREE.IUniform<number>;
  };
  readonly #cloudUniforms: {
    readonly color: THREE.IUniform<THREE.Color>;
    readonly opacity: THREE.IUniform<number>;
    readonly time: THREE.IUniform<number>;
    readonly scale: THREE.IUniform<number>;
  };
  readonly #radius: number;
  readonly #cloudHeight: number;
  readonly #lightDistance = 180;

  #elapsed = 0;
  #disposed = false;

  public constructor(scene: THREE.Scene, options: SkyOptions = {}) {
    this.#scene = scene;
    this.cycle = options.cycle ?? new DayNightCycle();
    this.#radius = options.radius ?? 400;
    this.#cloudHeight = options.cloudHeight ?? 150;

    const zenith = { value: new THREE.Color(0x4a8fd4) };
    const horizon = { value: new THREE.Color(0xa8cdf0) };
    const sunColor = { value: new THREE.Color(0xfff3d6) };
    const sunDirection = { value: new THREE.Vector3(0, 1, 0) };
    const sunIntensity = { value: 1 };
    this.#uniformes = { zenith, horizon, sunColor, sunDirection, sunIntensity };

    // I. 天穹：BackSide + 关闭深度写入/测试，永远作为背景最先绘制。
    this.#domeMaterial = new THREE.ShaderMaterial({
      name: 'sky:dome',
      uniforms: {
        uZenithColor: zenith,
        uHorizonColor: horizon,
        uSunColor: sunColor,
        uSunDirection: sunDirection,
        uSunIntensity: sunIntensity,
      },
      vertexShader: DOME_VERTEX_SHADER,
      fragmentShader: DOME_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    const dome = new THREE.Mesh(new THREE.SphereGeometry(this.#radius, 32, 16), this.#domeMaterial);
    dome.name = 'sky:dome';
    dome.frustumCulled = false;
    dome.renderOrder = -1000;

    // II. 太阳与月亮：简单的自发光球体，位置由昼夜循环驱动。
    this.#sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.#radius * 0.035, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff3d6, fog: false, toneMapped: false }),
    );
    this.#sunMesh.name = 'sky:sun';
    this.#sunMesh.frustumCulled = false;
    this.#sunMesh.renderOrder = -900;

    this.#moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.#radius * 0.026, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xdfe6ff, fog: false, toneMapped: false }),
    );
    this.#moonMesh.name = 'sky:moon';
    this.#moonMesh.frustumCulled = false;
    this.#moonMesh.renderOrder = -900;

    this.group = new THREE.Group();
    this.group.name = 'sky';
    this.group.add(dome, this.#sunMesh, this.#moonMesh);

    // III. 云层：一块水平平面 + 片元噪声，不占显存也不依赖 canvas。
    const cloudColor = { value: new THREE.Color(0xffffff) };
    const cloudOpacity = { value: 0.7 };
    const cloudTime = { value: 0 };
    const cloudScale = { value: options.cloudScale ?? 6 };
    this.#cloudUniforms = {
      color: cloudColor,
      opacity: cloudOpacity,
      time: cloudTime,
      scale: cloudScale,
    };

    this.#cloudMaterial = new THREE.ShaderMaterial({
      name: 'sky:clouds',
      uniforms: {
        uCloudColor: cloudColor,
        uOpacity: cloudOpacity,
        uTime: cloudTime,
        uScale: cloudScale,
      },
      vertexShader: CLOUD_VERTEX_SHADER,
      fragmentShader: CLOUD_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    const cloudGeometry = new THREE.PlaneGeometry(
      options.cloudSize ?? 4000,
      options.cloudSize ?? 4000,
    );
    cloudGeometry.rotateX(-Math.PI / 2);
    const clouds = new THREE.Mesh(cloudGeometry, this.#cloudMaterial);
    clouds.name = 'sky:clouds';
    clouds.frustumCulled = false;
    clouds.renderOrder = -800;

    this.cloudGroup = new THREE.Group();
    this.cloudGroup.name = 'sky:clouds-anchor';
    this.cloudGroup.position.y = this.#cloudHeight;
    this.cloudGroup.add(clouds);

    scene.add(this.group, this.cloudGroup);

    this.update(0);
  }

  /** 当前天空状态（复用缓冲）。 */
  public get state(): SkyState {
    return this.cycle.state;
  }

  /**
   * 推进一帧并刷新天空对象。
   *
   * @param deltaSeconds - 经过的秒数。
   * @param follow - 跟随位置（通常是相机世界坐标）；省略时保持原位。
   */
  public update(deltaSeconds: number, follow?: THREE.Vector3): void {
    this.cycle.advance(deltaSeconds);
    this.#elapsed += deltaSeconds;
    const state = this.cycle.state;

    // I. 天穹与太阳。
    this.#uniformes.zenith.value.copy(state.zenithColor);
    this.#uniformes.horizon.value.copy(state.horizonColor);
    this.#uniformes.sunColor.value.copy(state.sunColor);
    this.#uniformes.sunDirection.value.copy(state.sunDirection);
    this.#uniformes.sunIntensity.value = state.sunIntensity;

    this.#sunMesh.position.copy(state.sunDirection).multiplyScalar(this.#radius * 0.88);
    this.#moonMesh.position.copy(state.moonDirection).multiplyScalar(this.#radius * 0.82);
    const sunMaterial = this.#sunMesh.material as THREE.MeshBasicMaterial;
    sunMaterial.color.copy(state.sunColor);
    // 太阳沉到地平线以下后仍然可见会非常出戏，因此在略低于地平线时才隐藏。
    this.#sunMesh.visible = state.sunDirection.y > -0.05;
    this.#moonMesh.visible = state.moonDirection.y > -0.05;

    // II. 云层。
    this.#cloudUniforms.color.value.copy(state.cloudColor);
    this.#cloudUniforms.opacity.value = state.cloudOpacity;
    this.#cloudUniforms.time.value = this.#elapsed;

    // III. 跟随相机：天穹整体跟随，云层只跟随水平位置。
    if (follow !== undefined) {
      this.group.position.copy(follow);
      this.cloudGroup.position.set(follow.x, this.#cloudHeight, follow.z);
    }

    // IV. 雾色：与天空同步插值，否则远处地形会在天空背景上"浮起来"。
    this.applyFog(this.#scene.fog);
  }

  /** 把当前雾色写入场景的雾。 */
  public applyFog(fog: FogLike | null): void {
    if (fog === null) {
      return;
    }
    fog.color.copy(this.cycle.state.fogColor);
  }

  /**
   * 用当前天空状态驱动光照装置。
   *
   * 1. 太阳在地平线以上时，平行光沿太阳方向、取太阳色与太阳强度。
   * 2. 太阳落下后切换到月亮方向与月光强度，避免夜里变成纯黑（玩家会完全失去参照）。
   * 3. 半球光提供方向性环境项：朝上的面拿天顶色，朝下的面拿地面反弹色。
   * 4. 环境光提供与法线无关的底线，见下面的说明。
   */
  public syncEnvironment(rig: EnvironmentRig): void {
    const state = this.cycle.state;
    const sunAboveHorizon = state.sunDirection.y >= 0;
    const direction = sunAboveHorizon ? state.sunDirection : state.moonDirection;

    rig.sunLight.position.copy(direction).multiplyScalar(this.#lightDistance);
    rig.sunLight.color.copy(sunAboveHorizon ? state.sunColor : MOON_LIGHT_COLOR);
    rig.sunLight.intensity = sunAboveHorizon ? state.sunIntensity : state.moonIntensity;
    rig.sunLight.visible = rig.sunLight.intensity > 0.01;

    // I. 半球光：天空项 + 地面反弹项。
    // 1. 天空项用天顶色与地平线色混合，随昼夜变色。
    rig.hemisphereLight.intensity = state.ambientIntensity;
    rig.hemisphereLight.color.copy(state.zenithColor).lerp(state.horizonColor, 0.35);
    // 2. 地面反弹项原来是一个固定的暗棕色，导致所有**朝下的面**（树叶底面、悬崖内侧）
    //    在白天也只有一点点光，Lambert 算出来几乎是纯黑。这里改成"地平线色 × 地面反照率"：
    //    地面越亮、天空越亮，反弹越强，白天和黄昏都能得到可见的深色而不是黑。
    rig.hemisphereLight.groundColor.copy(state.horizonColor).multiply(GROUND_BOUNCE);

    // II. 环境光：与法线无关的底线。
    // 1. 半球光无法覆盖"朝下"这一整类面，环境光是它们唯一的保底光源。
    // 2. 强度随昼夜相位缩放：白天约 0.28，夜晚按 ambientIntensity 的比例降到约 0.1，
    //    既保证树叶底面是深绿而不是黑，也不会把夜晚洗成灰色。
    rig.ambientLight.color.copy(state.zenithColor).lerp(state.horizonColor, 0.5);
    rig.ambientLight.intensity = state.ambientIntensity * AMBIENT_FLOOR_RATIO;
  }

  /** 释放所有几何体与材质，并把天空从场景里移除。 */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    for (const group of [this.group, this.cloudGroup]) {
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) {
          return;
        }
        const geometry = object.geometry as THREE.BufferGeometry;
        geometry.dispose();
        // 一个 Mesh 既可以挂单个材质，也可以挂材质数组；两种都要释放。
        const material = object.material as THREE.Material | THREE.Material[];
        const entries: THREE.Material[] = Array.isArray(material) ? material : [material];
        for (const entry of entries) {
          entry.dispose();
        }
      });
      group.removeFromParent();
      group.clear();
    }
  }
}
