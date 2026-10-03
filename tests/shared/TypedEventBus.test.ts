import { describe, it, expect, vi } from 'vitest';
import { TypedEventBus, EventBusTimeoutError } from '../../src/shared/events/TypedEventBus';

interface TestEvents {
  'a:num': number;
  'b:obj': { x: number };
  'c:void': void;
}

const quiet = () => ({ onError: vi.fn(), onLeakWarning: vi.fn() });

describe('TypedEventBus', () => {
  it('delivers payloads synchronously in registration order', () => {
    const bus = new TypedEventBus<TestEvents>();
    const calls: string[] = [];
    bus.on('a:num', (n) => calls.push(`1:${n}`));
    bus.on('a:num', (n) => calls.push(`2:${n}`));
    bus.emit('a:num', 7);
    calls.push('after');
    expect(calls).toEqual(['1:7', '2:7', 'after']);
  });

  it('supports void events without payload argument', () => {
    const bus = new TypedEventBus<TestEvents>();
    const fn = vi.fn();
    bus.on('c:void', fn);
    bus.emit('c:void');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe function and off() both remove handlers', () => {
    const bus = new TypedEventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    const unsub = bus.on('a:num', a);
    bus.on('a:num', b);
    unsub();
    unsub(); // idempotent
    bus.off('a:num', b);
    bus.emit('a:num', 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(bus.listenerCount('a:num')).toBe(0);
    expect(bus.eventNames()).toEqual([]);
  });

  it('once() fires exactly once, even if re-emitted inside the handler', () => {
    const bus = new TypedEventBus<TestEvents>();
    const fn = vi.fn((n: number) => {
      if (n === 1) bus.emit('a:num', 2);
    });
    bus.once('a:num', fn);
    bus.emit('a:num', 1);
    bus.emit('a:num', 3);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('isolates handler errors: other handlers still run and emit does not throw', () => {
    const opts = quiet();
    const bus = new TypedEventBus<TestEvents>(opts);
    const after = vi.fn();
    bus.on('a:num', () => {
      throw new Error('boom');
    });
    bus.on('a:num', after);
    expect(() => { bus.emit('a:num', 1); }).not.toThrow();
    expect(after).toHaveBeenCalledWith(1);
    expect(opts.onError).toHaveBeenCalledWith(expect.any(Error), 'a:num');
  });

  it('reports async handler rejections via onError', async () => {
    const opts = quiet();
    const bus = new TypedEventBus<TestEvents>(opts);
    bus.on('a:num', async () => {
      throw new Error('async boom');
    });
    bus.emit('a:num', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(opts.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'async boom' }), 'a:num');
  });

  it('survives an onError callback that itself throws', () => {
    const bus = new TypedEventBus<TestEvents>({
      onError: () => {
        throw new Error('onError broke');
      },
    });
    bus.on('a:num', () => {
      throw new Error('x');
    });
    expect(() => { bus.emit('a:num', 1); }).not.toThrow();
  });

  it('uses a snapshot: listeners added during emit are not called in that emit', () => {
    const bus = new TypedEventBus<TestEvents>();
    const late = vi.fn();
    bus.on('a:num', () => {
      bus.on('a:num', late);
    });
    bus.emit('a:num', 1);
    expect(late).not.toHaveBeenCalled();
    bus.emit('a:num', 2);
    expect(late).toHaveBeenCalledWith(2);
  });

  it('skips listeners removed during emit before they run', () => {
    const bus = new TypedEventBus<TestEvents>();
    const second = vi.fn();
    let unsubSecond = () => {};
    bus.on('a:num', () => { unsubSecond(); });
    unsubSecond = bus.on('a:num', second);
    bus.emit('a:num', 1);
    expect(second).not.toHaveBeenCalled();
  });

  it('allows the same function registered twice and removes one at a time', () => {
    const bus = new TypedEventBus<TestEvents>();
    const fn = vi.fn();
    bus.on('a:num', fn);
    bus.on('a:num', fn);
    bus.emit('a:num', 1);
    expect(fn).toHaveBeenCalledTimes(2);
    bus.off('a:num', fn);
    bus.emit('a:num', 2);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('onAny receives every event after named handlers', () => {
    const bus = new TypedEventBus<TestEvents>();
    const order: string[] = [];
    bus.on('b:obj', () => order.push('named'));
    const unsub = bus.onAny((ev, p) => order.push(`any:${ev}:${JSON.stringify(p)}`));
    bus.emit('b:obj', { x: 1 });
    bus.emit('c:void');
    unsub();
    bus.emit('a:num', 9);
    expect(order).toEqual(['named', 'any:b:obj:{"x":1}', 'any:c:void:undefined']);
  });

  it('emits a leak warning once when maxListeners is exceeded', () => {
    const opts = quiet();
    const bus = new TypedEventBus<TestEvents>({ ...opts, maxListeners: 2 });
    for (let i = 0; i < 5; i++) bus.on('a:num', () => {});
    expect(opts.onLeakWarning).toHaveBeenCalledTimes(1);
    expect(opts.onLeakWarning).toHaveBeenCalledWith('a:num', 3);
  });

  it('rejects non-function handlers', () => {
    const bus = new TypedEventBus<TestEvents>();
    expect(() => bus.on('a:num', 42 as unknown as () => void)).toThrow(TypeError);
  });

  describe('waitFor', () => {
    it('resolves with the next matching payload', async () => {
      const bus = new TypedEventBus<TestEvents>();
      const p = bus.waitFor('b:obj', { filter: (o) => o.x > 1 });
      bus.emit('b:obj', { x: 1 });
      bus.emit('b:obj', { x: 2 });
      await expect(p).resolves.toEqual({ x: 2 });
      expect(bus.listenerCount('b:obj')).toBe(0);
    });

    it('rejects on timeout and cleans up', async () => {
      vi.useFakeTimers();
      try {
        const bus = new TypedEventBus<TestEvents>();
        const p = bus.waitFor('a:num', { timeoutMs: 100 });
        vi.advanceTimersByTime(100);
        await expect(p).rejects.toBeInstanceOf(EventBusTimeoutError);
        expect(bus.listenerCount('a:num')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects when aborted (before or during wait)', async () => {
      const bus = new TypedEventBus<TestEvents>();
      const pre = new AbortController();
      pre.abort();
      await expect(bus.waitFor('a:num', { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });

      const ac = new AbortController();
      const p = bus.waitFor('a:num', { signal: ac.signal, timeoutMs: 10_000 });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(bus.listenerCount('a:num')).toBe(0);
    });
  });

  it('removeAll(event) and removeAll() clear listeners', () => {
    const bus = new TypedEventBus<TestEvents>();
    const fn = vi.fn();
    bus.on('a:num', fn);
    bus.on('b:obj', fn);
    bus.onAny(fn);
    bus.removeAll('a:num');
    expect(bus.listenerCount('a:num')).toBe(0);
    expect(bus.listenerCount()).toBe(1);
    bus.removeAll();
    bus.emit('b:obj', { x: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('after dispose: emit is a no-op, subscribing throws', () => {
    const bus = new TypedEventBus<TestEvents>();
    const fn = vi.fn();
    bus.on('a:num', fn);
    bus.dispose();
    expect(bus.disposed).toBe(true);
    expect(() => { bus.emit('a:num', 1); }).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
    expect(() => bus.on('a:num', fn)).toThrow(/disposed/);
    expect(() => bus.onAny(() => {})).toThrow(/disposed/);
  });

  it('handles high-frequency emits without growth (lip-sync / cursor scale)', () => {
    const bus = new TypedEventBus<TestEvents>();
    let sum = 0;
    bus.on('a:num', (n) => (sum += n));
    for (let i = 0; i < 100_000; i++) bus.emit('a:num', 1);
    expect(sum).toBe(100_000);
    expect(bus.listenerCount()).toBe(1);
  });
});
