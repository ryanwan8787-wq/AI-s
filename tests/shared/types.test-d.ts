/**
 * 編譯期型別測試（vitest typecheck）。確保 API 誤用會在編譯期被擋下。
 */
import { describe, it, expectTypeOf } from 'vitest';
import { TypedEventBus } from '../../src/shared/events/TypedEventBus';
import type { MainEventMap, RendererEventMap, SharedEvents } from '../../src/shared/events/EventMap';
import type { CompanionApi, InvokeParsed, InvokeResponse } from '../../src/shared/ipc/channels';
import type { AppConfig } from '../../src/shared/config/schema';
import type { MemoryItem } from '../../src/shared/providers/memory';

describe('TypedEventBus types', () => {
  const bus = new TypedEventBus<MainEventMap>();

  it('infers payload types', () => {
    bus.on('avatar:emotion', (p) => {
      expectTypeOf(p).toEqualTypeOf<SharedEvents['avatar:emotion']>();
    });
  });

  it('void events take no payload; others require one', () => {
    bus.emit('ptt:down');
    bus.emit('audio:muted', { muted: true });
    // @ts-expect-error payload required
    bus.emit('audio:muted');
    // @ts-expect-error void event takes no payload
    bus.emit('ptt:down', 1);
    // @ts-expect-error wrong payload shape
    bus.emit('avatar:emotion', { turnId: null, emotion: 'ecstatic' });
  });

  it('rejects unknown and cross-process events', () => {
    // @ts-expect-error unknown event
    bus.on('nope:event', () => {});
    const rbus = new TypedEventBus<RendererEventMap>();
    // @ts-expect-error main-only event is not on the renderer bus
    rbus.on('stt:audioChunk', () => {});
    // @ts-expect-error renderer-only event is not on the main bus
    bus.on('render:frame', () => {});
  });
});

describe('IPC types', () => {
  it('maps invoke request/response types', () => {
    expectTypeOf<InvokeResponse<'config:get'>>().toEqualTypeOf<AppConfig>();
    expectTypeOf<InvokeResponse<'memory:list'>>().toEqualTypeOf<MemoryItem[]>();
    expectTypeOf<InvokeParsed<'memory:list'>['limit']>().toEqualTypeOf<number>();
  });

  it('CompanionApi enforces channel payloads', () => {
    const api = {} as CompanionApi;
    void api.invoke('config:get');
    void api.invoke('llm:switchModel', { model: 'qwen3:8b' });
    // @ts-expect-error missing payload
    void api.invoke('llm:switchModel');
    // @ts-expect-error unknown channel
    void api.invoke('fs:read', {});
    api.send('window:dragMove', { dx: 1, dy: 2 });
    // @ts-expect-error wrong payload
    api.send('window:dragMove', { x: 1 });
    api.on('avatar:emotion', (p) => {
      expectTypeOf(p.emotion).toEqualTypeOf<SharedEvents['avatar:emotion']['emotion']>();
    });
    // @ts-expect-error not a push channel
    api.on('stt:audioChunk', () => {});
  });
});
