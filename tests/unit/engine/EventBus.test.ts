import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '@/engine/events/EventBus';
import { BlockId } from '@/world/BlockRegistry';

describe('EventBus', () => {
  it('delivers a payload to every subscriber', () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();

    bus.on('block:broken', first);
    bus.on('block:broken', second);
    bus.emit('block:broken', { x: 1, y: 2, z: 3, block: BlockId.Stone });

    expect(first).toHaveBeenCalledWith({ x: 1, y: 2, z: 3, block: BlockId.Stone });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not deliver events to listeners of another event', () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.on('block:placed', listener);
    bus.emit('block:broken', { x: 0, y: 0, z: 0, block: BlockId.Dirt });

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const listener = vi.fn();

    const off = bus.on('item:collected', listener);
    bus.emit('item:collected', { item: BlockId.Dirt, count: 1 });
    off();
    bus.emit('item:collected', { item: BlockId.Dirt, count: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('item:collected')).toBe(0);
  });

  it('is idempotent when the same function subscribes twice', () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.on('ui:notice', listener);
    bus.on('ui:notice', listener);
    bus.emit('ui:notice', { text: 'saved', tone: 'info' });

    // A `Set` is used rather than an array precisely so double registration from a
    // hot-reload or a duplicated setup call cannot double-fire a sound or a drop.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('supports once()', () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.once('hotbar:selection-changed', listener);
    bus.emit('hotbar:selection-changed', { index: 1 });
    bus.emit('hotbar:selection-changed', { index: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ index: 1 });
  });

  it('lets a listener unsubscribe itself without skipping others', () => {
    const bus = new EventBus();
    const order: string[] = [];

    const offSecond = bus.on('time:tick', () => {
      order.push('first');
      offSecond();
    });
    bus.on('time:tick', () => {
      order.push('second');
    });

    bus.emit('time:tick', { deltaSeconds: 0.016 });
    expect(order).toEqual(['first', 'second']);

    order.length = 0;
    bus.emit('time:tick', { deltaSeconds: 0.016 });
    expect(order).toEqual(['second']);
  });

  it('lets a listener subscribe during dispatch', () => {
    const bus = new EventBus();
    const late = vi.fn();

    bus.on('player:landed', () => {
      bus.on('player:landed', late);
    });

    bus.emit('player:landed', { distance: 3 });
    // The new listener must not fire for the emission that registered it, which
    // is why `emit` iterates a snapshot.
    expect(late).not.toHaveBeenCalled();

    bus.emit('player:landed', { distance: 3 });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('handles nested emissions', () => {
    const bus = new EventBus();
    const inner = vi.fn();

    bus.on('time:tick', () => {
      bus.emit('time:phase-changed', { phase: 'dusk' });
    });
    bus.on('time:phase-changed', inner);

    bus.emit('time:tick', { deltaSeconds: 1 });

    expect(inner).toHaveBeenCalledWith({ phase: 'dusk' });
  });

  it('clears every subscription', () => {
    const bus = new EventBus();
    bus.on('ui:notice', vi.fn());
    bus.on('time:tick', vi.fn());

    bus.clear();

    expect(bus.listenerCount('ui:notice')).toBe(0);
    expect(bus.listenerCount('time:tick')).toBe(0);
  });

  it('emitting without listeners is a no-op', () => {
    const bus = new EventBus();
    expect(() => {
      bus.emit('player:chunk-changed', { cx: 1, cz: 1 });
    }).not.toThrow();
  });
});
