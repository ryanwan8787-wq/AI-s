/**
 * IPC 白名單 —— renderer 與 main 之間**唯一**的通訊契約。
 *
 * 三種方向：
 * - invoke：renderer → main，有回應（ipcRenderer.invoke / ipcMain.handle）
 * - send  ：renderer → main，無回應（高頻：拖曳、音訊分塊、命中狀態）
 * - push  ：main → renderer（webContents.send），即 SharedEvents 的子集
 *
 * 規則：
 * - preload 只允許此檔列出的 channel；其他一律拒絕。
 * - main 端 handler 一律先以 `request` schema 驗證 payload（不信任 renderer）。
 * - `windows` 限定哪個視窗可以使用該 channel（avatar / settings），由 main 依 sender 判斷。
 * - push 的 payload 型別直接取自 SharedEvents，確保事件與 IPC 不會漂移。
 */
import { z } from 'zod';
import type { AppConfig, AppConfigPatch } from '../config/schema';
import type { SharedEvents } from '../events/EventMap';
import type { LlmModelInfo, LlmRunningModel } from '../providers/llm';
import type { GpuSnapshot } from '../providers/gpu';
import type { SttStatus } from '../providers/stt';
import type { VoiceInfo } from '../providers/tts';
import type { MemoryExport, MemoryItem } from '../providers/memory';
import { MEMORY_KINDS } from '../providers/memory';
import { RADIAL_MENU_ITEMS } from '../types/domain';
import { WhisperComputeType, WhisperDevice, WhisperModelSize } from '../config/schema';

export type WindowRole = 'avatar' | 'settings';
const BOTH: readonly WindowRole[] = ['avatar', 'settings'];
const AVATAR: readonly WindowRole[] = ['avatar'];
const SETTINGS: readonly WindowRole[] = ['settings'];

/* ------------------------------------------------------------------ */
/* 共用 schema                                                         */
/* ------------------------------------------------------------------ */

const ModelTag = z.string().min(1).max(200).regex(/^[\w.\-:/]+$/, 'invalid model tag');
const UtteranceIdSchema = z.string().regex(/^u-[a-z0-9-]{1,64}$/);
/** 16kHz 100ms ≈ 1600 samples；上限 1 秒，防止濫用。 */
const PcmChunk = z.instanceof(Float32Array).refine((a) => a.length > 0 && a.length <= 16000, 'pcm chunk size');
/** 有限數值，拒絕 NaN / Infinity。 */
const Finite = z.number().refine(Number.isFinite, 'must be finite');

/* ------------------------------------------------------------------ */
/* invoke                                                              */
/* ------------------------------------------------------------------ */

interface InvokeDef<Req extends z.ZodType, Res> {
  readonly request: Req;
  /** 僅作為型別標記（phantom）；不在執行期驗證回應（main 是可信端）。 */
  readonly response?: Res;
  readonly windows: readonly WindowRole[];
}
/** 柯里化：先指定回應型別，request 型別由 schema 推導。 */
const invoke =
  <Res>() =>
  <Req extends z.ZodType>(request: Req, windows: readonly WindowRole[]): InvokeDef<Req, Res> => ({ request, windows });

export interface AppInfo {
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: string;
  readonly userDataPath: string;
}

export interface WindowHitConfig {
  readonly hitTest: 'raycast' | 'alpha';
}

/** VRM 檔案經 main 授權後回傳的 URL（companion-asset://...）。 */
export interface AssetGrant {
  readonly url: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export const INVOKE_CHANNELS = {
  'app:getInfo': invoke<AppInfo>()(z.void(), BOTH),
  'app:quit': invoke<void>()(z.void(), BOTH),

  'config:get': invoke<AppConfig>()(z.void(), BOTH),
  /** payload 為 DeepPartial<AppConfig>；main 深度合併後以完整 schema 驗證，這裡只確認是 plain object。 */
  'config:patch': invoke<AppConfig>()(z.record(z.string(), z.unknown()) as z.ZodType<AppConfigPatch>, BOTH),
  'config:reset': invoke<AppConfig>()(z.object({ section: z.string().max(32).optional() }), SETTINGS),

  'window:openSettings': invoke<void>()(z.void(), AVATAR),
  'window:getHitConfig': invoke<WindowHitConfig>()(z.void(), AVATAR),

  /** 開啟檔案對話框選 VRM；回傳授權過的 URL。取消時回傳 null。 */
  'avatar:pickVrm': invoke<AssetGrant | null>()(z.void(), BOTH),
  /** 為 config 中已存在的路徑取得 URL（啟動時）。main 會檢查副檔名與檔案存在。 */
  'avatar:grantPath': invoke<AssetGrant>()(z.object({ path: z.string().min(1).max(1024) }), BOTH),
  'avatar:pickVrma': invoke<AssetGrant | null>()(z.void(), SETTINGS),

  'llm:listModels': invoke<{ installed: LlmModelInfo[]; running: LlmRunningModel[] }>()(z.void(), BOTH),
  'llm:switchModel': invoke<{ ok: boolean; model: string }>()(z.object({ model: ModelTag }), BOTH),
  'llm:testSchema': invoke<{ ok: boolean; message: string }>()(z.object({ model: ModelTag }), SETTINGS),

  'stt:getStatus': invoke<SttStatus>()(z.void(), BOTH),
  'stt:reload': invoke<{ ok: boolean }>()(
    z.object({ modelSize: WhisperModelSize, device: WhisperDevice, computeType: WhisperComputeType }),
    SETTINGS,
  ),
  'stt:cancelDownload': invoke<void>()(z.void(), SETTINGS),
  'stt:listDownloaded': invoke<WhisperModelSize[]>()(z.void(), SETTINGS),

  'tts:listVoices': invoke<VoiceInfo[]>()(z.object({ locale: z.string().max(16).optional() }), SETTINGS),
  'tts:preview': invoke<{ ok: boolean }>()(
    z.object({ voice: z.string().max(64), text: z.string().min(1).max(100) }),
    SETTINGS,
  ),

  'resource:getGpu': invoke<GpuSnapshot | null>()(z.void(), SETTINGS),

  'memory:list': invoke<MemoryItem[]>()(
    z.object({
      kind: z.enum(MEMORY_KINDS).optional(),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    }),
    SETTINGS,
  ),
  'memory:update': invoke<MemoryItem | null>()(
    z.object({
      id: z.number().int().positive(),
      content: z.string().min(1).max(500).optional(),
      importance: z.number().int().min(1).max(5).optional(),
      pinned: z.boolean().optional(),
    }),
    SETTINGS,
  ),
  'memory:delete': invoke<boolean>()(z.object({ id: z.number().int().positive() }), SETTINGS),
  'memory:export': invoke<MemoryExport>()(z.object({ includeTurns: z.boolean() }), SETTINGS),
  'memory:clear': invoke<void>()(z.object({ confirm: z.literal('DELETE') }), SETTINGS),
} as const;

/* ------------------------------------------------------------------ */
/* send（renderer → main，無回應）                                     */
/* ------------------------------------------------------------------ */

export const SEND_CHANNELS = {
  /** 命中測試結果：true → 接收滑鼠事件；false → 穿透。 */
  'window:setInteractive': { request: z.object({ interactive: z.boolean() }), windows: AVATAR },
  'window:dragStart': { request: z.void(), windows: AVATAR },
  /** 螢幕 DIP 座標的累積位移（相對 dragStart）。 */
  'window:dragMove': { request: z.object({ dx: Finite, dy: Finite }), windows: AVATAR },
  'window:dragEnd': { request: z.void(), windows: AVATAR },
  /** renderer 回報活動狀態（idle 超時等），main 決定最終 FPS 等級。 */
  'window:rendererActive': { request: z.object({ active: z.boolean() }), windows: AVATAR },

  'stt:audioChunk': {
    request: z.object({ utteranceId: UtteranceIdSchema, pcm: PcmChunk }),
    windows: AVATAR,
  },
  'stt:utteranceEnd': { request: z.object({ utteranceId: UtteranceIdSchema }), windows: AVATAR },
  'stt:utteranceCancel': { request: z.object({ utteranceId: UtteranceIdSchema }), windows: AVATAR },

  'dialogue:submitText': { request: z.object({ text: z.string().min(1).max(2000) }), windows: BOTH },
  'dialogue:interrupt': { request: z.object({ reason: z.enum(['bargeIn', 'user']) }), windows: AVATAR },

  'audio:playbackStarted': {
    request: z.object({ turnId: z.string().max(64), seq: z.number().int().min(0) }),
    windows: AVATAR,
  },
  'audio:playbackEnded': {
    request: z.object({ turnId: z.string().max(64), seq: z.number().int().min(0), interrupted: z.boolean() }),
    windows: AVATAR,
  },
  'audio:micState': {
    request: z.object({ state: z.enum(['off', 'listening', 'paused', 'denied', 'unavailable']) }),
    windows: AVATAR,
  },

  'interaction:menuSelected': { request: z.object({ item: z.enum(RADIAL_MENU_ITEMS) }), windows: AVATAR },
  'interaction:headPat': { request: z.void(), windows: AVATAR },

  'log:write': {
    request: z.object({
      level: z.enum(['error', 'warn', 'info', 'debug']),
      scope: z.string().max(40),
      message: z.string().max(4000),
    }),
    windows: BOTH,
  },
} as const;

/* ------------------------------------------------------------------ */
/* push（main → renderer）                                             */
/* ------------------------------------------------------------------ */

/** main 會轉發給 renderer 的事件（SharedEvents 子集）。值為接收的視窗。 */
export const PUSH_CHANNELS = {
  'config:changed': BOTH,
  'avatar:emotion': AVATAR,
  'avatar:action': AVATAR,
  'avatar:outfit': AVATAR,
  'dialogue:phase': BOTH,
  'dialogue:userText': AVATAR,
  'dialogue:replyDelta': AVATAR,
  'dialogue:sentence': AVATAR,
  'dialogue:completed': AVATAR,
  'dialogue:interrupted': AVATAR,
  'stt:status': BOTH,
  'stt:final': AVATAR,
  'stt:downloadProgress': SETTINGS,
  'tts:audio': AVATAR,
  'tts:failed': AVATAR,
  'audio:muted': BOTH,
  'ptt:down': AVATAR,
  'ptt:up': AVATAR,
  'llm:models': SETTINGS,
  'llm:switchStarted': BOTH,
  'llm:switchCompleted': BOTH,
  'llm:switchFailed': BOTH,
  'llm:needsModelSelection': BOTH,
  'resource:gpu': SETTINGS,
  'cursor:position': AVATAR,
  'window:activity': AVATAR,
  'sidecar:state': BOTH,
  'app:error': BOTH,
  'app:notice': BOTH,
} as const satisfies Partial<Record<keyof SharedEvents, readonly WindowRole[]>>;

/* ------------------------------------------------------------------ */
/* 型別工具                                                             */
/* ------------------------------------------------------------------ */

export type InvokeChannel = keyof typeof INVOKE_CHANNELS;
export type SendChannel = keyof typeof SEND_CHANNELS;
export type PushChannel = keyof typeof PUSH_CHANNELS;

/** renderer 端呼叫時的參數型別（zod input，含 default 前的形狀）。 */
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof INVOKE_CHANNELS)[C]['request']>;
/** main 端 handler 收到的已驗證型別（zod output）。 */
export type InvokeParsed<C extends InvokeChannel> = z.output<(typeof INVOKE_CHANNELS)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> =
  (typeof INVOKE_CHANNELS)[C] extends InvokeDef<z.ZodType, infer R> ? R : never;

export type SendRequest<C extends SendChannel> = z.input<(typeof SEND_CHANNELS)[C]['request']>;
export type SendParsed<C extends SendChannel> = z.output<(typeof SEND_CHANNELS)[C]['request']>;

export type PushPayload<C extends PushChannel> = SharedEvents[C];

/** 型別安全的 renderer API（preload 實作、renderer 使用）。 */
export interface CompanionApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: [InvokeRequest<C>] extends [void] ? [] : [payload: InvokeRequest<C>]
  ): Promise<InvokeResponse<C>>;
  send<C extends SendChannel>(channel: C, ...args: [SendRequest<C>] extends [void] ? [] : [payload: SendRequest<C>]): void;
  on<C extends PushChannel>(channel: C, handler: (payload: PushPayload<C>) => void): () => void;
}

/* ------------------------------------------------------------------ */
/* 執行期驗證工具（main 與 preload 共用）                               */
/* ------------------------------------------------------------------ */

const INVOKE_SET: ReadonlySet<string> = new Set(Object.keys(INVOKE_CHANNELS));
const SEND_SET: ReadonlySet<string> = new Set(Object.keys(SEND_CHANNELS));
const PUSH_SET: ReadonlySet<string> = new Set(Object.keys(PUSH_CHANNELS));

export const isInvokeChannel = (c: unknown): c is InvokeChannel => typeof c === 'string' && INVOKE_SET.has(c);
export const isSendChannel = (c: unknown): c is SendChannel => typeof c === 'string' && SEND_SET.has(c);
export const isPushChannel = (c: unknown): c is PushChannel => typeof c === 'string' && PUSH_SET.has(c);

export function isAllowedForWindow(
  kind: 'invoke' | 'send' | 'push',
  channel: InvokeChannel | SendChannel | PushChannel,
  role: WindowRole,
): boolean {
  // channel 可能來自不可信輸入（型別斷言後），因此仍以 Map 查找並處理 undefined
  const table: Readonly<Record<string, { windows: readonly WindowRole[] } | readonly WindowRole[]>> =
    kind === 'invoke' ? INVOKE_CHANNELS : kind === 'send' ? SEND_CHANNELS : PUSH_CHANNELS;
  const entry = Object.hasOwn(table, channel) ? table[channel] : undefined;
  if (entry === undefined) return false;
  const windows = Array.isArray(entry) ? (entry as readonly WindowRole[]) : (entry as { windows: readonly WindowRole[] }).windows;
  return windows.includes(role);
}

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function validateInvoke<C extends InvokeChannel>(channel: C, payload: unknown): ValidationResult<InvokeParsed<C>> {
  const r = INVOKE_CHANNELS[channel].request.safeParse(payload);
  return r.success ? { ok: true, data: r.data as InvokeParsed<C> } : { ok: false, error: z.prettifyError(r.error) };
}

export function validateSend<C extends SendChannel>(channel: C, payload: unknown): ValidationResult<SendParsed<C>> {
  const r = SEND_CHANNELS[channel].request.safeParse(payload);
  return r.success ? { ok: true, data: r.data as SendParsed<C> } : { ok: false, error: z.prettifyError(r.error) };
}

/** Electron IPC channel 實際名稱前綴，避免與其他套件衝突。 */
export const IPC_PREFIX = 'companion:' as const;
export const ipcName = (kind: 'invoke' | 'send' | 'push', channel: string): string => `${IPC_PREFIX}${kind}:${channel}`;
