import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventBus } from '@/engine/events/EventBus';

/**
 * Adversarial `EventBus` tests (T7 QA).
 *
 * I. Why re-entrancy is the interesting part
 *
 * The bus is safe for the easy case (a listener unsubscribing itself while the
 * bus is dispatching) — that is what `#pendingRemovals` is for. The cases below
 * are the ones the design does *not* obviously cover:
 *
 * 1. a listener that throws, which used to abort the dispatch before the depth
 *    counter was decremented — now contained per listener and unwound in a
 *    `finally`;
 * 2. `once` combined with a listener that re-emits its own event — **still
 *    broken**, kept as a characterisation;
 * 3. `clear()` called from inside a listener.
 *
 * All three are reachable from gameplay code (any UI, audio or particle
 * listener can throw; a "show notice once" handler can trigger another notice),
 * so their behaviour is pinned down here rather than left to chance.
 */

/** Convenience payload for `time:tick`. */
const TICK = { deltaSeconds: 1 } as const;

describe('EventBus: basic dispatch', () => {
  it('does nothing when an event has no listeners', () => {
    const bus = new EventBus();
    expect(() => {
      bus.emit('time:tick', TICK);
    }).not.toThrow();
    expect(bus.listenerCount('time:tick')).toBe(0);
  });

  it('invokes every listener in subscription order', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('time:tick', () => order.push('first'));
    bus.on('time:tick', () => order.push('second'));
    bus.on('time:tick', () => order.push('third'));

    bus.emit('time:tick', TICK);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(bus.listenerCount('time:tick')).toBe(3);
  });

  it('keeps events isolated from each other', () => {
    const bus = new EventBus();
    let ticks = 0;
    let notices = 0;
    bus.on('time:tick', () => {
      ticks += 1;
    });
    bus.on('ui:notice', () => {
      notices += 1;
    });

    bus.emit('ui:notice', { text: 'saved', tone: 'info' });

    expect(ticks).toBe(0);
    expect(notices).toBe(1);
  });

  it('subscribes the same function only once, and either handle removes it', () => {
    // Listeners live in a `Set`, so this is the documented "subscribing is
    // idempotent" behaviour. It also means one `off()` call cancels *both*
    // logical subscriptions — worth pinning down because a caller that
    // subscribes twice and unsubscribes twice would expect the second handle to
    // be a no-op.
    const bus = new EventBus();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };

    const firstOff = bus.on('time:tick', listener);
    const secondOff = bus.on('time:tick', listener);
    expect(bus.listenerCount('time:tick')).toBe(1);

    bus.emit('time:tick', TICK);
    expect(calls).toBe(1);

    firstOff();
    expect(bus.listenerCount('time:tick')).toBe(0);
    secondOff();
    expect(bus.listenerCount('time:tick')).toBe(0);

    bus.emit('time:tick', TICK);
    expect(calls).toBe(1);
  });
});

describe('EventBus: mutation during dispatch', () => {
  it('still calls a listener that was unsubscribed mid-dispatch, then stops', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    let offSecond = (): void => {};

    bus.on('time:tick', () => {
      seen.push('first');
      offSecond();
    });
    offSecond = bus.on('time:tick', () => seen.push('second'));

    bus.emit('time:tick', TICK);
    // Snapshot semantics: the current dispatch completes with the listeners it
    // started with, so `second` is called exactly once.
    expect(seen).toEqual(['first', 'second']);
    expect(bus.listenerCount('time:tick')).toBe(1);

    bus.emit('time:tick', TICK);
    expect(seen).toEqual(['first', 'second', 'first']);
  });

  it('does not call a listener that subscribed mid-dispatch until the next emit', () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.on('time:tick', () => {
      seen.push('first');
      bus.on('time:tick', () => seen.push('late'));
    });

    bus.emit('time:tick', TICK);
    expect(seen).toEqual(['first']);

    bus.emit('time:tick', TICK);
    expect(seen).toEqual(['first', 'first', 'late']);
  });

  it('flushes removals queued during a nested emit once the outermost emit ends', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    let offNested = (): void => {};

    // The outer listener emits a *different* event, so the nested dispatch has
    // its own listener set and the depth reaches 2.
    bus.on('time:tick', () => {
      seen.push('outer');
      bus.emit('ui:notice', { text: 'nested', tone: 'info' });
    });
    offNested = bus.on('ui:notice', () => {
      seen.push('nested');
      offNested();
    });

    bus.emit('time:tick', TICK);

    expect(seen).toEqual(['outer', 'nested']);
    // The removal was deferred to the end of the outermost dispatch, and it did
    // happen: the second emission reaches nobody.
    expect(bus.listenerCount('ui:notice')).toBe(0);

    bus.emit('ui:notice', { text: 'again', tone: 'info' });
    expect(seen).toEqual(['outer', 'nested']);
  });
});

describe('EventBus: once() re-entrancy', () => {
  it('fires exactly once when the handler emits the same event again (unfixed defect)', () => {
    // Still broken after the `try/finally` fix to `emit`: `once` removes the
    // subscription by calling its own handle, but while a dispatch is in progress
    // that removal is *deferred* until the outermost emit returns. The nested
    // emit therefore takes a fresh snapshot of a set that still contains the
    // listener, so the "exactly one emission" contract is broken and the handler
    // runs twice.
    //
    // Reproduce: `bus.once('time:tick', handler)` where `handler` emits
    // `time:tick` once — the handler is invoked for both emissions.
    //
    // This is a characterisation of the current behaviour: if `once` is made
    // re-entrancy safe (for example by removing the entry from the set
    // immediately and keeping a separate "already fired" flag), this test will
    // start failing, which is the signal to flip it into a regression test that
    // asserts `seen === [1]`.
    const bus = new EventBus();
    const seen: number[] = [];
    let reentered = false;

    bus.once('time:tick', (payload) => {
      seen.push(payload.deltaSeconds);
      if (!reentered) {
        reentered = true;
        bus.emit('time:tick', { deltaSeconds: 2 });
      }
    });

    bus.emit('time:tick', TICK);

    expect(seen).toEqual([1, 2]);
    // It is at least removed afterwards, so this is a double-fire, not a leak.
    expect(bus.listenerCount('time:tick')).toBe(0);
  });

  it('fires exactly once for two sequential emissions', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.once('time:tick', () => {
      calls += 1;
    });

    bus.emit('time:tick', TICK);
    bus.emit('time:tick', TICK);

    expect(calls).toBe(1);
    expect(bus.listenerCount('time:tick')).toBe(0);
  });

  it('keeps running the remaining listeners after a once handler removes itself', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.once('time:tick', () => seen.push('once'));
    bus.on('time:tick', () => seen.push('always'));

    bus.emit('time:tick', TICK);

    expect(seen).toEqual(['once', 'always']);
  });
});

describe('EventBus: a throwing listener is contained', () => {
  // The bus reports a contained failure through `logger.error`, which writes to
  // `console.error`. Silenced here so the suite output stays readable; the
  // assertions below are about the bus, not about the log line.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not leak the dispatch depth, so later unsubscribes still work', () => {
    // `emit` unwinds its depth counter in a `finally`, so a throwing listener can
    // no longer leave the bus in a state where every later `off()` is deferred
    // forever. The removal queue must stay empty and the listener must really be
    // gone after its owner calls the handle.
    const bus = new EventBus();
    const seen: string[] = [];

    bus.on('ui:notice', () => {
      throw new Error('listener exploded');
    });
    const offSubscriber = bus.on('time:tick', () => {
      seen.push('subscriber');
    });

    // The failure is reported, not rethrown: `emit` must not take the caller
    // (the game loop) down with a broken listener.
    expect(() => {
      bus.emit('ui:notice', { text: 'boom', tone: 'error' });
    }).not.toThrow();

    offSubscriber();
    expect(bus.listenerCount('time:tick')).toBe(0);

    bus.emit('time:tick', TICK);
    expect(seen).toEqual([]);

    // Repeated subscribe/unsubscribe pairs after a failure must not accumulate.
    for (let i = 0; i < 50; i += 1) {
      const off = bus.on('time:tick', () => {
        seen.push('extra');
      });
      off();
    }
    expect(bus.listenerCount('time:tick')).toBe(0);
    bus.emit('time:tick', TICK);
    expect(seen).toEqual([]);
  });

  it('runs the remaining listeners of a dispatch where one listener threw', () => {
    // `block:broken` fans out to audio, particles, inventory and the save system.
    // A missing sound must not stop the player from collecting drops, so a
    // throwing listener is skipped and the chain continues.
    const bus = new EventBus();
    const seen: string[] = [];

    bus.on('time:tick', () => {
      seen.push('first');
      throw new Error('mid-dispatch failure');
    });
    bus.on('time:tick', () => seen.push('second'));
    bus.on('time:tick', () => seen.push('third'));

    expect(() => {
      bus.emit('time:tick', TICK);
    }).not.toThrow();
    expect(seen).toEqual(['first', 'second', 'third']);
  });

  it('still unwinds the depth counter for a nested dispatch', () => {
    // The `finally` has to run on every level of a nested emit, otherwise the
    // outermost `off()` would be queued and never flushed.
    const bus = new EventBus();
    const seen: string[] = [];

    bus.on('time:tick', () => {
      seen.push('outer');
      bus.emit('ui:notice', { text: 'nested', tone: 'info' });
    });
    bus.on('ui:notice', () => {
      seen.push('inner');
      throw new Error('inner failure');
    });
    const offInner = bus.on('ui:notice', () => {
      seen.push('inner-second');
    });

    bus.emit('time:tick', TICK);

    // The nested dispatch is contained at depth 2: both `ui:notice` listeners ran
    // and the failure inside the first one did not stop the second.
    expect(seen).toEqual(['outer', 'inner', 'inner-second']);
    expect(bus.listenerCount('ui:notice')).toBe(2);

    offInner();
    expect(bus.listenerCount('ui:notice')).toBe(1);

    // The removal really happened: only the throwing listener is left, and its
    // failure is contained again.
    bus.emit('ui:notice', { text: 'again', tone: 'info' });
    expect(seen).toEqual(['outer', 'inner', 'inner-second', 'inner']);
    expect(bus.listenerCount('ui:notice')).toBe(1);
  });
});

describe('EventBus: clear() during dispatch', () => {
  it('completes the current snapshot but removes every listener afterwards', () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.on('time:tick', () => {
      seen.push('first');
      bus.clear();
    });
    bus.on('time:tick', () => seen.push('second'));

    bus.emit('time:tick', TICK);

    // The snapshot was taken before the dispatch, so `second` still runs; it is
    // the last thing this bus will ever dispatch because `clear` emptied the map.
    expect(seen).toEqual(['first', 'second']);
    expect(bus.listenerCount('time:tick')).toBe(0);

    bus.emit('time:tick', TICK);
    expect(seen).toEqual(['first', 'second']);
  });

  it('can still be used after being cleared from inside a listener', () => {
    // `clear()` resets the depth to 0 while `emit` is still on the stack, so the
    // final decrement drives it to -1. New subscriptions still work; recording
    // this because a future `try/finally` fix must not change it.
    const bus = new EventBus();
    bus.on('time:tick', () => {
      bus.clear();
    });
    bus.emit('time:tick', TICK);

    const seen: number[] = [];
    const off = bus.on('time:tick', (payload) => {
      seen.push(payload.deltaSeconds);
    });
    bus.emit('time:tick', { deltaSeconds: 5 });
    expect(seen).toEqual([5]);

    off();
    expect(bus.listenerCount('time:tick')).toBe(0);
    bus.emit('time:tick', { deltaSeconds: 6 });
    expect(seen).toEqual([5]);
  });
});
