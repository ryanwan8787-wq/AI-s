import { describe, it, expect, vi } from 'vitest';
import {
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  SEND_CHANNELS,
  ipcName,
  isAllowedForWindow,
  isInvokeChannel,
  isPushChannel,
  isSendChannel,
  validateInvoke,
  validateSend,
} from '../../src/shared/ipc/channels';
import { TypedEventBus } from '../../src/shared/events/TypedEventBus';
import { bridgeBusToTransport, bridgeTransportToBus, type PushSubscriber } from '../../src/shared/events/IpcBridge';
import type { MainEventMap, RendererEventMap, SharedEvents } from '../../src/shared/events/EventMap';

describe('IPC whitelist', () => {
  it('channel name guards accept only declared channels', () => {
    expect(isInvokeChannel('config:get')).toBe(true);
    expect(isInvokeChannel('fs:readFile')).toBe(false);
    expect(isInvokeChannel(42)).toBe(false);
    expect(isSendChannel('window:dragMove')).toBe(true);
    expect(isSendChannel('config:get')).toBe(false);
    expect(isPushChannel('avatar:emotion')).toBe(true);
    expect(isPushChannel('stt:audioChunk')).toBe(false); // main-only event must never be pushed
  });

  it('channel names are unique across kinds after prefixing', () => {
    const names = [
      ...Object.keys(INVOKE_CHANNELS).map((c) => ipcName('invoke', c)),
      ...Object.keys(SEND_CHANNELS).map((c) => ipcName('send', c)),
      ...Object.keys(PUSH_CHANNELS).map((c) => ipcName('push', c)),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('companion:'))).toBe(true);
  });

  it('enforces per-window permissions', () => {
    expect(isAllowedForWindow('invoke', 'memory:clear', 'settings')).toBe(true);
    expect(isAllowedForWindow('invoke', 'memory:clear', 'avatar')).toBe(false);
    expect(isAllowedForWindow('send', 'window:dragMove', 'settings')).toBe(false);
    expect(isAllowedForWindow('push', 'tts:audio', 'avatar')).toBe(true);
    expect(isAllowedForWindow('push', 'tts:audio', 'settings')).toBe(false);
  });

  it('validateInvoke applies defaults and rejects bad payloads', () => {
    const ok = validateInvoke('memory:list', {});
    expect(ok).toEqual({ ok: true, data: { limit: 100, offset: 0 } });
    expect(validateInvoke('memory:list', { limit: 10_000 }).ok).toBe(false);
    expect(validateInvoke('llm:switchModel', { model: 'qwen3:8b' }).ok).toBe(true);
    expect(validateInvoke('llm:switchModel', { model: 'rm -rf /; echo' }).ok).toBe(false);
    expect(validateInvoke('memory:clear', { confirm: 'yes' }).ok).toBe(false);
    expect(validateInvoke('config:get', undefined).ok).toBe(true);
  });

  it('config:patch only accepts plain objects at the IPC layer', () => {
    expect(validateInvoke('config:patch', { llm: { model: 'x' } }).ok).toBe(true);
    expect(validateInvoke('config:patch', 'string').ok).toBe(false);
    expect(validateInvoke('config:patch', null).ok).toBe(false);
  });

  it('validateSend checks PCM chunks and finite drag deltas', () => {
    expect(validateSend('stt:audioChunk', { utteranceId: 'u-abc-1', pcm: new Float32Array(1600) }).ok).toBe(true);
    expect(validateSend('stt:audioChunk', { utteranceId: 'u-abc-1', pcm: [0.1, 0.2] }).ok).toBe(false);
    expect(validateSend('stt:audioChunk', { utteranceId: 'u-abc-1', pcm: new Float32Array(0) }).ok).toBe(false);
    expect(validateSend('stt:audioChunk', { utteranceId: 'u-abc-1', pcm: new Float32Array(16001) }).ok).toBe(false);
    expect(validateSend('stt:audioChunk', { utteranceId: '../etc', pcm: new Float32Array(10) }).ok).toBe(false);
    expect(validateSend('window:dragMove', { dx: 3, dy: -2 }).ok).toBe(true);
    expect(validateSend('window:dragMove', { dx: Number.NaN, dy: 0 }).ok).toBe(false);
    expect(validateSend('window:dragMove', { dx: Infinity, dy: 0 }).ok).toBe(false);
  });

  it('every push channel targets at least one window', () => {
    for (const [ch, wins] of Object.entries(PUSH_CHANNELS)) expect(wins.length, ch).toBeGreaterThan(0);
  });
});

describe('IpcBridge', () => {
  it('forwards only whitelisted events allowed for the window role', () => {
    const bus = new TypedEventBus<MainEventMap>();
    const sent: [string, unknown][] = [];
    const unbridge = bridgeBusToTransport(bus, { send: (c, p) => sent.push([c, p]), isAlive: () => true }, 'settings');

    bus.emit('stt:downloadProgress', { modelSize: 'small', downloadedBytes: 1, totalBytes: 2, fraction: 0.5 });
    bus.emit('tts:audio', { turnId: 't1' as never, seq: 0, data: new Uint8Array(1), last: true }); // avatar only
    bus.emit('stt:audioChunk', { utteranceId: 'u-1' as never, pcm: new Float32Array(1) }); // main only
    expect(sent.map((s) => s[0])).toEqual(['stt:downloadProgress']);

    unbridge();
    bus.emit('stt:downloadProgress', { modelSize: 'small', downloadedBytes: 2, totalBytes: 2, fraction: 1 });
    expect(sent).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it('skips dead transports and reports send errors without breaking the bus', () => {
    const bus = new TypedEventBus<MainEventMap>();
    let alive = false;
    const send = vi.fn(() => {
      throw new Error('webContents destroyed');
    });
    const onError = vi.fn();
    bridgeBusToTransport(bus, { send, isAlive: () => alive }, 'avatar', { onError });
    bus.emit('audio:muted', { muted: true });
    expect(send).not.toHaveBeenCalled();
    alive = true;
    expect(() => { bus.emit('audio:muted', { muted: false }); }).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'audio:muted');
  });

  it('renderer side re-emits pushes on the local bus', () => {
    const handlers = new Map<string, (p: unknown) => void>();
    const api: PushSubscriber = {
      on: (ch, h) => {
        handlers.set(ch, h as (p: unknown) => void);
        return () => handlers.delete(ch);
      },
    };
    const bus = new TypedEventBus<RendererEventMap>();
    const got = vi.fn();
    bus.on('avatar:emotion', got);
    const unbridge = bridgeTransportToBus(api, bus, ['avatar:emotion', 'ptt:down']);
    const payload: SharedEvents['avatar:emotion'] = { turnId: null, emotion: 'happy' };
    handlers.get('avatar:emotion')?.(payload);
    expect(got).toHaveBeenCalledWith(payload);
    unbridge();
    expect(handlers.size).toBe(0);
  });

  it('end-to-end: main bus → fake IPC → renderer bus', () => {
    const mainBus = new TypedEventBus<MainEventMap>();
    const rendererBus = new TypedEventBus<RendererEventMap>();
    const subs = new Map<string, Set<(p: unknown) => void>>();
    const api: PushSubscriber = {
      on: (ch, h) => {
        const set = subs.get(ch) ?? new Set();
        set.add(h as (p: unknown) => void);
        subs.set(ch, set);
        return () => set.delete(h as (p: unknown) => void);
      },
    };
    // structuredClone 模擬 Electron IPC 的序列化
    bridgeBusToTransport(mainBus, { send: (c, p) => subs.get(c)?.forEach((h) => { h(structuredClone(p)); }), isAlive: () => true }, 'avatar');
    bridgeTransportToBus(api, rendererBus);

    const got = vi.fn();
    rendererBus.on('tts:audio', got);
    const data = new Uint8Array([1, 2, 3]);
    mainBus.emit('tts:audio', { turnId: 't-1' as never, seq: 2, data, last: false });
    expect(got).toHaveBeenCalledTimes(1);
    const recv = got.mock.calls[0]![0] as SharedEvents['tts:audio'];
    expect(recv.seq).toBe(2);
    expect(recv.data).toBeInstanceOf(Uint8Array);
    expect([...recv.data]).toEqual([1, 2, 3]);
    expect(recv.data).not.toBe(data); // copied, not shared
  });
});
