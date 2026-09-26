import { describe, expect, it, vi } from 'vitest';

import { GameStateMachine } from '@/app/GameState';

describe('GameStateMachine', () => {
  it('starts in boot and is not interactive', () => {
    const machine = new GameStateMachine();

    expect(machine.current).toBe('boot');
    expect(machine.interactive).toBe(false);
    expect(machine.pointerLocked).toBe(false);
    expect(machine.label).toBe('正在启动');
  });

  it('walks the normal boot path', () => {
    const machine = new GameStateMachine();

    expect(machine.transition('menu')).toBe(true);
    expect(machine.transition('world-loading')).toBe(true);
    expect(machine.transition('playing')).toBe(true);
    expect(machine.interactive).toBe(true);
    expect(machine.pointerLocked).toBe(true);
  });

  it('rejects transitions that are not in the table', () => {
    const machine = new GameStateMachine();

    // The machine exists to make illegal combinations impossible, so jumping
    // straight into the world before the menu must not be allowed.
    expect(machine.transition('playing')).toBe(false);
    expect(machine.current).toBe('boot');
  });

  it('reports a no-op when transitioning to the current state', () => {
    const machine = new GameStateMachine();
    machine.transition('menu');

    expect(machine.transition('menu')).toBe(false);
  });

  it('notifies listeners with the previous state', () => {
    const machine = new GameStateMachine();
    machine.transition('menu');
    const listener = vi.fn();
    machine.onChange(listener);

    machine.transition('world-loading');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ from: 'menu', to: 'world-loading' });
  });

  it('stays silent when asked to', () => {
    const machine = new GameStateMachine();
    const listener = vi.fn();
    machine.onChange(listener);

    machine.transition('menu', { silent: true });

    expect(listener).not.toHaveBeenCalled();
    expect(machine.current).toBe('menu');
  });

  it('stops notifying after unsubscribe', () => {
    const machine = new GameStateMachine();
    const listener = vi.fn();
    const off = machine.onChange(listener);
    off();

    machine.transition('menu');

    expect(listener).not.toHaveBeenCalled();
  });

  it('pauses and resumes', () => {
    const machine = new GameStateMachine();
    machine.transition('menu');
    machine.transition('world-loading');
    machine.transition('playing');

    expect(machine.transition('paused')).toBe(true);
    expect(machine.info.simulates).toBe(false);
    expect(machine.pointerLocked).toBe(false);

    expect(machine.transition('playing')).toBe(true);
    expect(machine.info.simulates).toBe(true);
  });

  it('opens and closes the inventory only from play', () => {
    const machine = new GameStateMachine();
    machine.transition('menu');
    machine.transition('world-loading');
    machine.transition('playing');

    expect(machine.transition('inventory')).toBe(true);
    expect(machine.info.simulates).toBe(false);
    expect(machine.transition('playing')).toBe(true);

    machine.transition('paused');
    // Opening the inventory from the pause menu would leave two overlapping
    // modal screens and no way to close both.
    expect(machine.transition('inventory')).toBe(false);
  });

  it('returns from settings to whichever screen opened it', () => {
    const fromMenu = new GameStateMachine();
    fromMenu.transition('menu');
    fromMenu.transition('settings');
    expect(fromMenu.leaveSettings()).toBe(true);
    expect(fromMenu.current).toBe('menu');

    const fromPause = new GameStateMachine();
    fromPause.transition('menu');
    fromPause.transition('world-loading');
    fromPause.transition('playing');
    fromPause.transition('paused');
    fromPause.transition('settings');
    expect(fromPause.leaveSettings()).toBe(true);
    expect(fromPause.current).toBe('paused');
  });

  it('does nothing when leaving settings from another state', () => {
    const machine = new GameStateMachine();
    machine.transition('menu');

    expect(machine.leaveSettings()).toBe(false);
    expect(machine.current).toBe('menu');
  });

  it('reaches the error state from anywhere and recovers to the menu', () => {
    const machine = new GameStateMachine();
    machine.transition('menu');
    machine.transition('world-loading');

    expect(machine.transition('error')).toBe(true);
    expect(machine.transition('menu')).toBe(true);
    expect(machine.current).toBe('menu');
  });

  it('exposes a description for every state', () => {
    for (const state of [
      'boot',
      'menu',
      'world-loading',
      'playing',
      'paused',
      'inventory',
      'settings',
      'saving',
      'error',
    ] as const) {
      const machine = new GameStateMachine(state);
      expect(machine.info.name).toBe(state);
      expect(machine.info.label.length).toBeGreaterThan(0);
    }
  });
});
