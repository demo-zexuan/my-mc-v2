import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  applySettingsPatch,
  normalizeSettings,
  qualityProfileFor,
} from '@/settings/types';

describe('normalizeSettings', () => {
  it('returns the defaults for empty or invalid input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('reads every field from a valid object', () => {
    const settings = normalizeSettings({
      mouseSensitivity: 0.003,
      fov: 90,
      renderDistance: 12,
      masterVolume: 0.25,
      sfxVolume: 0.5,
      ambientVolume: 0.1,
      graphicsQuality: 'high',
      shadows: false,
      debugOverlay: false,
      viewBobbing: false,
      invertY: true,
    });

    expect(settings.fov).toBe(90);
    expect(settings.renderDistance).toBe(12);
    expect(settings.graphicsQuality).toBe('high');
    expect(settings.invertY).toBe(true);
    expect(settings.shadows).toBe(false);
  });

  it('clamps numeric values into their supported range', () => {
    const settings = normalizeSettings({
      fov: 500,
      renderDistance: 999,
      masterVolume: -3,
      mouseSensitivity: 100,
    });

    expect(settings.fov).toBe(SETTINGS_LIMITS.fov.max);
    expect(settings.renderDistance).toBe(SETTINGS_LIMITS.renderDistance.max);
    expect(settings.masterVolume).toBe(SETTINGS_LIMITS.masterVolume.min);
    expect(settings.mouseSensitivity).toBe(SETTINGS_LIMITS.mouseSensitivity.max);
  });

  it('rounds the render distance to a whole number of chunks', () => {
    expect(normalizeSettings({ renderDistance: 7.6 }).renderDistance).toBe(8);
  });

  it('falls back per field so one broken key does not reset everything', () => {
    const settings = normalizeSettings({ fov: 'wide', masterVolume: 0.3 });

    expect(settings.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(settings.masterVolume).toBe(0.3);
  });

  it('rejects NaN and Infinity by restoring the default', () => {
    // Falling back to the nearest bound would silently pin a corrupt value to an
    // extreme, which reads to the player as the game ignoring their settings.
    expect(normalizeSettings({ fov: Number.NaN }).fov).toBe(DEFAULT_SETTINGS.fov);
    expect(normalizeSettings({ masterVolume: Number.POSITIVE_INFINITY }).masterVolume).toBe(
      DEFAULT_SETTINGS.masterVolume,
    );
  });

  it('falls back for an unknown quality preset', () => {
    expect(normalizeSettings({ graphicsQuality: 'ultra' }).graphicsQuality).toBe(
      DEFAULT_SETTINGS.graphicsQuality,
    );
  });

  it('falls back for a non-boolean toggle', () => {
    expect(normalizeSettings({ shadows: 'yes' }).shadows).toBe(DEFAULT_SETTINGS.shadows);
  });
});

describe('applySettingsPatch', () => {
  it('merges only the provided fields', () => {
    const updated = applySettingsPatch(DEFAULT_SETTINGS, { fov: 100 });

    expect(updated.fov).toBe(100);
    expect(updated.renderDistance).toBe(DEFAULT_SETTINGS.renderDistance);
  });

  it('validates the merged result', () => {
    const updated = applySettingsPatch(DEFAULT_SETTINGS, { fov: 10_000 });
    expect(updated.fov).toBe(SETTINGS_LIMITS.fov.max);
  });

  it('does not mutate the input', () => {
    const original = { ...DEFAULT_SETTINGS };
    applySettingsPatch(original, { fov: 60 });
    expect(original).toEqual(DEFAULT_SETTINGS);
  });
});

describe('qualityProfileFor', () => {
  it('turns shadows off for the low preset regardless of the toggle', () => {
    const profile = qualityProfileFor({
      ...DEFAULT_SETTINGS,
      graphicsQuality: 'low',
      shadows: true,
    });

    expect(profile.shadows).toBe(false);
    expect(profile.pixelRatioCap).toBe(1);
    expect(profile.antialias).toBe(false);
  });

  it('honours the explicit shadow toggle on higher presets', () => {
    expect(qualityProfileFor({ ...DEFAULT_SETTINGS, graphicsQuality: 'high' }).shadows).toBe(true);
    expect(
      qualityProfileFor({ ...DEFAULT_SETTINGS, graphicsQuality: 'high', shadows: false }).shadows,
    ).toBe(false);
  });

  it('increases the pixel ratio cap with quality', () => {
    const low = qualityProfileFor({ ...DEFAULT_SETTINGS, graphicsQuality: 'low' }).pixelRatioCap;
    const medium = qualityProfileFor({
      ...DEFAULT_SETTINGS,
      graphicsQuality: 'medium',
    }).pixelRatioCap;
    const high = qualityProfileFor({ ...DEFAULT_SETTINGS, graphicsQuality: 'high' }).pixelRatioCap;

    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });
});
