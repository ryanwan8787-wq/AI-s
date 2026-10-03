/**
 * 型別化事件匯流排（同步派送、零依賴、main / renderer 共用）。
 *
 * 設計：
 * - **同步派送**：emit 回傳前所有 handler 都已執行。即時性需求（口型、動畫）不能等 microtask。
 *   handler 若需非同步工作請自行 `void doAsync()`；回傳的 Promise 若 reject 會被捕捉並送往 onError。
 * - **錯誤隔離**：單一 handler throw 不影響其他 handler，也不會讓 emit throw。
 * - **快照迭代**：emit 期間新增/移除 listener 不影響本次派送（移除的 listener 若尚未執行則跳過）。
 * - **void 事件**：payload 型別為 void 的事件，`emit('x')` 不需第二個參數。
 * - **onAny**：供 IPC 橋接、log、測試使用；在具名 handler 之後執行。
 * - **洩漏偵測**：同一事件 listener 數超過 maxListeners 時呼叫 onLeakWarning 一次。
 */

import type { Unsubscribe } from '../types/domain';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 事件表的 value 可為任意 payload 型別
export type EventMapBase = Record<string, any>;

export type EventKey<M extends EventMapBase> = Extract<keyof M, string>;

/** void 事件不需要 payload 參數。 */
export type EmitArgs<M extends EventMapBase, K extends keyof M> = [M[K]] extends [void] ? [] : [payload: M[K]];

/** 回傳值會被忽略（若為 Promise，其 rejection 會送往 onError）。 */
export type Handler<P> = (payload: P) => unknown;

export type AnyHandler<M extends EventMapBase> = <K extends EventKey<M>>(event: K, payload: M[K]) => unknown;

export interface EventBusOptions {
  /** handler 拋錯（含 async reject）時呼叫；預設 console.error。 */
  onError?: (error: unknown, event: string) => void;
  /** 單一事件 listener 上限，超過時警告一次；0 = 不檢查。預設 50。 */
  maxListeners?: number;
  onLeakWarning?: (event: string, count: number) => void;
  /** 除錯名稱（出現在預設錯誤訊息中）。 */
  name?: string;
}

interface Entry {
  readonly fn: Handler<unknown>;
  readonly once: boolean;
  removed: boolean;
}

export interface WaitForOptions<P> {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 只有符合條件的 payload 才會 resolve。 */
  filter?: (payload: P) => boolean;
}

export class EventBusTimeoutError extends Error {
  constructor(event: string, ms: number) {
    super(`waitFor('${event}') timed out after ${ms}ms`);
    this.name = 'EventBusTimeoutError';
  }
}

export class EventBusAbortError extends Error {
  constructor(event: string) {
    super(`waitFor('${event}') aborted`);
    this.name = 'AbortError';
  }
}

export class TypedEventBus<M extends EventMapBase> {
  readonly #listeners = new Map<string, Entry[]>();
  readonly #any: { fn: AnyHandler<M>; removed: boolean }[] = [];
  readonly #warned = new Set<string>();
  readonly #onError: (error: unknown, event: string) => void;
  readonly #onLeak: (event: string, count: number) => void;
  readonly #max: number;
  readonly #name: string;
  #disposed = false;

  constructor(opts: EventBusOptions = {}) {
    this.#name = opts.name ?? 'bus';
    this.#max = opts.maxListeners ?? 50;
    this.#onError =
      opts.onError ??
      ((e, ev) => {
        console.error(`[${this.#name}] handler for '${ev}' failed:`, e);
      });
    this.#onLeak =
      opts.onLeakWarning ??
      ((ev, n) => {
        console.warn(`[${this.#name}] possible listener leak: '${ev}' has ${n} listeners (max ${this.#max})`);
      });
  }

  on<K extends EventKey<M>>(event: K, handler: Handler<M[K]>): Unsubscribe {
    return this.#add(event, handler as Handler<unknown>, false);
  }

  once<K extends EventKey<M>>(event: K, handler: Handler<M[K]>): Unsubscribe {
    return this.#add(event, handler as Handler<unknown>, true);
  }

  off<K extends EventKey<M>>(event: K, handler: Handler<M[K]>): void {
    const list = this.#listeners.get(event);
    if (!list) return;
    const idx = list.findIndex((e) => e.fn === handler && !e.removed);
    if (idx < 0) return;
    const entry = list[idx];
    if (entry) entry.removed = true;
    list.splice(idx, 1);
    if (list.length === 0) this.#listeners.delete(event);
  }

  /** 訂閱所有事件（在具名 handler 之後呼叫）。 */
  onAny(handler: AnyHandler<M>): Unsubscribe {
    this.#assertAlive();
    const entry = { fn: handler, removed: false };
    this.#any.push(entry);
    return () => {
      if (entry.removed) return;
      entry.removed = true;
      const i = this.#any.indexOf(entry);
      if (i >= 0) this.#any.splice(i, 1);
    };
  }

  emit<K extends EventKey<M>>(event: K, ...args: EmitArgs<M, K>): void {
    if (this.#disposed) return;
    const payload = args[0] as M[K];
    const list = this.#listeners.get(event);
    if (list && list.length > 0) {
      const snapshot = list.slice();
      for (const entry of snapshot) {
        if (entry.removed) continue;
        if (entry.once) this.#removeEntry(event, entry);
        this.#invoke(event, () => entry.fn(payload));
      }
    }
    if (this.#any.length > 0) {
      for (const entry of this.#any.slice()) {
        if (entry.removed) continue;
        this.#invoke(event, () => entry.fn(event, payload));
      }
    }
  }

  /** 等待下一次事件。可設逾時、AbortSignal 與過濾條件。 */
  waitFor<K extends EventKey<M>>(event: K, opts: WaitForOptions<M[K]> = {}): Promise<M[K]> {
    this.#assertAlive();
    return new Promise<M[K]>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new EventBusAbortError(event));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        unsub();
        if (timer !== undefined) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new EventBusAbortError(event));
      };
      const unsub = this.on(event, (p) => {
        if (opts.filter && !opts.filter(p)) return;
        cleanup();
        resolve(p);
      });
      if (opts.timeoutMs !== undefined) {
        const ms = opts.timeoutMs;
        timer = setTimeout(() => {
          cleanup();
          reject(new EventBusTimeoutError(event, ms));
        }, ms);
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  listenerCount(event?: EventKey<M>): number {
    if (event !== undefined) return this.#listeners.get(event)?.length ?? 0;
    let n = 0;
    for (const l of this.#listeners.values()) n += l.length;
    return n;
  }

  eventNames(): EventKey<M>[] {
    return [...this.#listeners.keys()] as EventKey<M>[];
  }

  /** 移除某事件（或全部）listener。 */
  removeAll(event?: EventKey<M>): void {
    const mark = (l: Entry[] | undefined): void => l?.forEach((e) => (e.removed = true));
    if (event !== undefined) {
      mark(this.#listeners.get(event));
      this.#listeners.delete(event);
    } else {
      for (const l of this.#listeners.values()) mark(l);
      this.#listeners.clear();
      this.#any.forEach((e) => (e.removed = true));
      this.#any.length = 0;
    }
  }

  /** 釋放；之後 emit 為 no-op，on/once/waitFor 會 throw。 */
  dispose(): void {
    this.removeAll();
    this.#disposed = true;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /* ---------------------------------------------------------------- */

  #add(event: string, fn: Handler<unknown>, once: boolean): Unsubscribe {
    this.#assertAlive();
    if (typeof fn !== 'function') throw new TypeError(`handler for '${event}' must be a function`);
    let list = this.#listeners.get(event);
    if (!list) {
      list = [];
      this.#listeners.set(event, list);
    }
    const entry: Entry = { fn, once, removed: false };
    list.push(entry);
    if (this.#max > 0 && list.length > this.#max && !this.#warned.has(event)) {
      this.#warned.add(event);
      this.#onLeak(event, list.length);
    }
    return () => { this.#removeEntry(event, entry); };
  }

  #removeEntry(event: string, entry: Entry): void {
    if (entry.removed) return;
    entry.removed = true;
    const list = this.#listeners.get(event);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.#listeners.delete(event);
  }

  #invoke(event: string, call: () => unknown): void {
    try {
      const r = call();
      if (r !== null && typeof r === 'object' && typeof (r as PromiseLike<unknown>).then === 'function') {
        (r as Promise<unknown>).then(undefined, (e: unknown) => { this.#safeOnError(e, event); });
      }
    } catch (e) {
      this.#safeOnError(e, event);
    }
  }

  #safeOnError(e: unknown, event: string): void {
    try {
      this.#onError(e, event);
    } catch {
      /* onError 本身失敗時吞掉，避免無限遞迴 */
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error(`[${this.#name}] event bus is disposed`);
  }
}
