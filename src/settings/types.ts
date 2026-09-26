/**
 * Player settings: shape, defaults, bounds and validation.
 *
 * I. Why settings are a flat immutable record
 *
 * 1. The UI edits them, the renderer reads them every frame, the audio system
 *    reads them on every sound and the save system persists them. A flat record
 *    with no optional fields makes all four consumers total: no `if (settings.x
 *    !== undefined)` branches in hot paths, which `exactOptionalPropertyTypes`
 *    would otherwise force everywhere.
 * 2. Immutability means a consumer can capture the object without fearing that a
 *    later UI edit mutates state it is still using.
 *
 * II. Validation instead of trust
 *
 * Settings come back from `localStorage`, which the player (or another tab, or a
 * browser extension) can edit. Values are clamped on read rather than rejected,
 * because a corrupted sensitivity must not prevent the game from starting.
 *
 * @module settings/types
 */

import { z } from 'zod';

/** Quality presets that map onto concrete renderer options. */
export type GraphicsQuality = 'low' | 'medium' | 'high';

/** The complete player-editable configuration. */
export interface GameSettings {
  /** Mouse look sensitivity in radians per pixel. */
  readonly mouseSensitivity: number;
  /** Vertical field of view in degrees. */
  readonly fov: number;
  /** Horizontal chunk radius kept loaded and rendered. */
  readonly renderDistance: number;
  /** Master output volume in `0 .. 1`. */
  readonly masterVolume: number;
  /** Sound effect volume in `0 .. 1`. */
  readonly sfxVolume: number;
  /** Ambient/looping sound volume in `0 .. 1`. */
  readonly ambientVolume: number;
  /** Renderer quality preset. */
  readonly graphicsQuality: GraphicsQuality;
  /** Whether the shadow pass runs. */
  readonly shadows: boolean;
  /** Whether the debug overlay starts visible. */
  readonly debugOverlay: boolean;
  /** Vertical field of view is also driven by sprint; this disables the kick. */
  readonly viewBobbing: boolean;
  /** Inverts the vertical look axis. */
  readonly invertY: boolean;
}

/** Numeric bounds enforced when settings are read or written. */
export const SETTINGS_LIMITS = {
  mouseSensitivity: { min: 0.0005, max: 0.01 },
  fov: { min: 50, max: 110 },
  renderDistance: { min: 2, max: 16 },
  masterVolume: { min: 0, max: 1 },
  sfxVolume: { min: 0, max: 1 },
  ambientVolume: { min: 0, max: 1 },
} as const satisfies Record<string, { readonly min: number; readonly max: number }>;

/** Values used on a first run. */
export const DEFAULT_SETTINGS: GameSettings = {
  mouseSensitivity: 0.0022,
  fov: 75,
  renderDistance: 8,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  ambientVolume: 0.5,
  graphicsQuality: 'medium',
  shadows: true,
  debugOverlay: true,
  viewBobbing: true,
  invertY: false,
};

const settingsSchema = z.object({
  mouseSensitivity: z.number().finite(),
  fov: z.number().finite(),
  renderDistance: z.number().finite(),
  masterVolume: z.number().finite(),
  sfxVolume: z.number().finite(),
  ambientVolume: z.number().finite(),
  graphicsQuality: z.enum(['low', 'medium', 'high']),
  shadows: z.boolean(),
  debugOverlay: z.boolean(),
  viewBobbing: z.boolean(),
  invertY: z.boolean(),
});

function readQuality(value: unknown): GraphicsQuality {
  return value === 'low' || value === 'medium' || value === 'high'
    ? value
    : DEFAULT_SETTINGS.graphicsQuality;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Coerces an arbitrary value into a valid settings object.
 *
 * Every field falls back to its default independently, so one corrupted key
 * cannot reset the whole configuration.
 *
 * @param value - Untrusted value, typically parsed JSON from storage.
 * @returns A complete, in-range settings object.
 */
export function normalizeSettings(value: unknown): GameSettings {
  const parsed = settingsSchema.safeParse(value);
  const source: Partial<Record<keyof GameSettings, unknown>> = parsed.success ? parsed.data : {};

  const number = (key: keyof typeof SETTINGS_LIMITS): number => {
    const raw = source[key];
    const fallback = DEFAULT_SETTINGS[key] as number;
    const limits = SETTINGS_LIMITS[key];
    return clamp(typeof raw === 'number' ? raw : fallback, limits.min, limits.max);
  };

  const boolean = (key: 'shadows' | 'debugOverlay' | 'viewBobbing' | 'invertY'): boolean => {
    const raw = source[key];
    return typeof raw === 'boolean' ? raw : DEFAULT_SETTINGS[key];
  };

  return {
    mouseSensitivity: number('mouseSensitivity'),
    fov: number('fov'),
    renderDistance: Math.round(number('renderDistance')),
    masterVolume: number('masterVolume'),
    sfxVolume: number('sfxVolume'),
    ambientVolume: number('ambientVolume'),
    graphicsQuality: readQuality(source.graphicsQuality),
    shadows: boolean('shadows'),
    debugOverlay: boolean('debugOverlay'),
    viewBobbing: boolean('viewBobbing'),
    invertY: boolean('invertY'),
  };
}

/**
 * Applies a partial update on top of existing settings.
 *
 * @param current - Settings to start from.
 * @param patch - Fields to change.
 * @returns A new, validated settings object.
 */
export function applySettingsPatch(
  current: GameSettings,
  patch: Partial<GameSettings>,
): GameSettings {
  return normalizeSettings({ ...current, ...patch });
}

/** Renderer options derived from the quality preset. */
export interface QualityProfile {
  readonly pixelRatioCap: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly fogNearFactor: number;
  readonly antialias: boolean;
}

/**
 * Maps the quality preset (and the explicit shadow toggle) onto renderer options.
 *
 * Keeping this mapping in one place means the settings screen, the renderer
 * factory and the debug panel cannot disagree about what "low" means.
 *
 * @param settings - Current settings.
 * @returns Concrete renderer options.
 */
export function qualityProfileFor(settings: GameSettings): QualityProfile {
  switch (settings.graphicsQuality) {
    case 'low':
      return {
        pixelRatioCap: 1,
        shadows: false,
        shadowMapSize: 1024,
        fogNearFactor: 0.35,
        antialias: false,
      };
    case 'high':
      return {
        pixelRatioCap: 2,
        shadows: settings.shadows,
        shadowMapSize: 2048,
        fogNearFactor: 0.6,
        antialias: true,
      };
    case 'medium':
    default:
      return {
        pixelRatioCap: 1.5,
        shadows: settings.shadows,
        shadowMapSize: 2048,
        fogNearFactor: 0.5,
        antialias: true,
      };
  }
}
