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

/** Narrows an untrusted value to a string-keyed record. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Reads and clamps one numeric field.
 *
 * I. Why a missing or non-finite value falls back to the default rather than to
 *    the nearest bound
 *
 * A corrupted sensitivity stored by another tab should restore the sane default
 * value, not silently pin the setting to its minimum, which would look like the
 * game ignoring the player's own configuration.
 */
function readNumber(
  record: Record<string, unknown>,
  key: keyof typeof SETTINGS_LIMITS,
  fallback: number,
): number {
  const raw = record[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  const limits = SETTINGS_LIMITS[key];
  return Math.min(limits.max, Math.max(limits.min, raw));
}

/** Reads one boolean field, falling back when the stored value is not a boolean. */
function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = record[key];
  return typeof raw === 'boolean' ? raw : fallback;
}

function readQuality(record: Record<string, unknown>): GraphicsQuality {
  const raw = record['graphicsQuality'];
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : DEFAULT_SETTINGS.graphicsQuality;
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
  const record = asRecord(value);

  return {
    mouseSensitivity: readNumber(
      record,
      'mouseSensitivity',
      DEFAULT_SETTINGS.mouseSensitivity,
    ),
    fov: readNumber(record, 'fov', DEFAULT_SETTINGS.fov),
    // A fractional render distance would create half-chunks in the streaming
    // radius arithmetic, so it is rounded to a whole chunk count.
    renderDistance: Math.round(readNumber(record, 'renderDistance', DEFAULT_SETTINGS.renderDistance)),
    masterVolume: readNumber(record, 'masterVolume', DEFAULT_SETTINGS.masterVolume),
    sfxVolume: readNumber(record, 'sfxVolume', DEFAULT_SETTINGS.sfxVolume),
    ambientVolume: readNumber(record, 'ambientVolume', DEFAULT_SETTINGS.ambientVolume),
    graphicsQuality: readQuality(record),
    shadows: readBoolean(record, 'shadows', DEFAULT_SETTINGS.shadows),
    debugOverlay: readBoolean(record, 'debugOverlay', DEFAULT_SETTINGS.debugOverlay),
    viewBobbing: readBoolean(record, 'viewBobbing', DEFAULT_SETTINGS.viewBobbing),
    invertY: readBoolean(record, 'invertY', DEFAULT_SETTINGS.invertY),
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
