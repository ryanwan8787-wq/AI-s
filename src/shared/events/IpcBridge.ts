/**
 * Event Bus ↔ IPC 橋接（與傳輸層無關，便於單元測試）。
 *
 * main 端：bridgeBusToTransport(mainBus, transport, role) —— 把 PUSH_CHANNELS 中允許給該視窗的事件送出。
 * renderer 端：bridgeTransportToBus(api, rendererBus) —— 把收到的 push 轉成本地 bus 事件。
 *
 * 防迴圈：renderer bus 上由 IPC 進來的事件不會再被送回 main（renderer 只透過 SEND_CHANNELS 主動送）。
 */
import { PUSH_CHANNELS, isAllowedForWindow, type PushChannel, type WindowRole } from '../ipc/channels';
import type { SharedEvents } from './EventMap';
import type { TypedEventBus, EventMapBase } from './TypedEventBus';
import type { Unsubscribe } from '../types/domain';

export interface PushTransport {
  /** 例如 `(ch, p) => win.webContents.send(ipcName('push', ch), p)` */
  send(channel: PushChannel, payload: unknown): void;
  /** 視窗已銷毀時回傳 false，橋接會略過。 */
  isAlive(): boolean;
}

const PUSH_KEYS = Object.keys(PUSH_CHANNELS) as PushChannel[];

export function bridgeBusToTransport<M extends SharedEvents & EventMapBase>(
  bus: TypedEventBus<M>,
  transport: PushTransport,
  role: WindowRole,
  opts: { onError?: (e: unknown, channel: PushChannel) => void } = {},
): Unsubscribe {
  const unsubs: Unsubscribe[] = [];
  for (const ch of PUSH_KEYS) {
    if (!isAllowedForWindow('push', ch, role)) continue;
    unsubs.push(
      bus.on(ch as Extract<keyof M, string>, (payload: unknown) => {
        if (!transport.isAlive()) return;
        try {
          transport.send(ch, payload);
        } catch (e) {
          opts.onError?.(e, ch);
        }
      }),
    );
  }
  return () => { unsubs.forEach((u) => { u(); }); };
}

export interface PushSubscriber {
  on<C extends PushChannel>(channel: C, handler: (payload: SharedEvents[C]) => void): () => void;
}

export function bridgeTransportToBus<M extends SharedEvents & EventMapBase>(
  api: PushSubscriber,
  bus: TypedEventBus<M>,
  channels: readonly PushChannel[] = PUSH_KEYS,
): Unsubscribe {
  const unsubs = channels.map((ch) =>
    api.on(ch, (payload) => {
      (bus.emit as (e: string, p: unknown) => void)(ch, payload);
    }),
  );
  return () => { unsubs.forEach((u) => { u(); }); };
}
