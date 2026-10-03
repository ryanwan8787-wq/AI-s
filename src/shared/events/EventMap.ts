/**
 * 事件定義。命名：`domain:verb`（過去式代表「已發生」，祈使句代表「請求」）。
 *
 * 三組事件：
 * - SharedEvents：payload 可結構化複製（無函式、無類別實例，ArrayBuffer/TypedArray 可），
 *   可透過 IPC 橋接（橋接白名單與 zod schema 在 src/shared/ipc/channels.ts）。
 * - MainEvents：只存在於 main 程序（可含 AbortSignal 等不可序列化物件）。
 * - RendererEvents：只存在於 renderer 程序。
 *
 * void payload 的事件以 `emit('x')` 觸發，不需第二個參數。
 */
import type { AppConfig } from '../config/schema';
import type { AIResponse } from '../ai/AIResponse';
import type {
  AnyAction,
  AvatarState,
  DialoguePhase,
  Emotion,
  HitRegion,
  RadialMenuItem,
  RenderActivity,
  ScreenPoint,
  TurnId,
  UtteranceId,
} from '../types/domain';
import type { AppErrorInfo } from '../types/errors';
import type { DownloadProgress, SttResult, SttStatus } from '../providers/stt';
import type { GpuSnapshot } from '../providers/gpu';
import type { LlmModelInfo, LlmRunningModel } from '../providers/llm';
import type { AvatarModelInfo } from '../providers/avatar';

/* ------------------------------------------------------------------ */
/* Shared（可跨 IPC）                                                   */
/* ------------------------------------------------------------------ */

export interface SharedEvents {
  /* 設定 */
  'config:changed': { readonly next: AppConfig; readonly changedPaths: readonly string[] };

  /* 角色 */
  'avatar:emotion': { readonly turnId: TurnId | null; readonly emotion: Emotion };
  'avatar:action': { readonly turnId: TurnId | null; readonly action: AnyAction };
  'avatar:outfit': { readonly outfitId: string };
  'avatar:stateChanged': { readonly from: AvatarState; readonly to: AvatarState };
  'avatar:modelLoaded': { readonly url: string; readonly info: AvatarModelInfo };
  'avatar:modelLoadFailed': { readonly url: string; readonly error: AppErrorInfo };

  /* 互動 */
  'interaction:click': { readonly region: HitRegion };
  'interaction:longPress': { readonly region: HitRegion | null };
  'interaction:menuSelected': { readonly item: RadialMenuItem };
  'interaction:headPat': void;

  /* 對話 */
  'dialogue:phase': { readonly phase: DialoguePhase; readonly turnId: TurnId | null };
  'dialogue:userText': { readonly turnId: TurnId; readonly text: string; readonly source: 'voice' | 'text' };
  /** reply 增量（給文字氣泡逐字顯示）。 */
  'dialogue:replyDelta': { readonly turnId: TurnId; readonly delta: string };
  'dialogue:sentence': { readonly turnId: TurnId; readonly seq: number; readonly text: string };
  'dialogue:completed': {
    readonly turnId: TurnId;
    readonly response: AIResponse;
    readonly degraded: boolean;
  };
  /** 使用者打斷（barge-in 或手動停止）。 */
  'dialogue:interrupted': { readonly turnId: TurnId | null; readonly reason: 'bargeIn' | 'user' | 'newTurn' };
  /** 使用者文字輸入（麥克風被拒時的替代路徑）。 */
  'dialogue:submitText': { readonly text: string };

  /* STT */
  'stt:status': SttStatus;
  'stt:final': SttResult;
  'stt:downloadProgress': DownloadProgress;

  /* TTS / 音訊 */
  'tts:audio': { readonly turnId: TurnId; readonly seq: number; readonly data: Uint8Array; readonly last: boolean };
  'tts:failed': { readonly turnId: TurnId; readonly seq: number; readonly error: AppErrorInfo };
  'audio:playbackStarted': { readonly turnId: TurnId; readonly seq: number };
  'audio:playbackEnded': { readonly turnId: TurnId; readonly seq: number; readonly interrupted: boolean };
  'audio:allPlaybackEnded': { readonly turnId: TurnId };
  'audio:bargeIn': void;
  'audio:micState': { readonly state: 'off' | 'listening' | 'paused' | 'denied' | 'unavailable' };
  'audio:muted': { readonly muted: boolean };

  /* PTT（main 從全域快捷鍵送出） */
  'ptt:down': void;
  'ptt:up': void;

  /* LLM / 模型 */
  'llm:models': { readonly installed: readonly LlmModelInfo[]; readonly running: readonly LlmRunningModel[] };
  'llm:switchStarted': { readonly from: string | null; readonly to: string };
  'llm:switchCompleted': { readonly model: string };
  'llm:switchFailed': { readonly attempted: string; readonly revertedTo: string | null; readonly error: AppErrorInfo };
  /** 預設模型未安裝 → 引導使用者從已安裝清單挑選。 */
  'llm:needsModelSelection': { readonly configured: string; readonly installed: readonly LlmModelInfo[] };

  /* 資源 */
  'resource:gpu': { readonly snapshot: GpuSnapshot | null };

  /* 視窗 / 渲染 */
  'cursor:position': ScreenPoint;
  'window:activity': { readonly activity: RenderActivity };

  /* sidecar */
  'sidecar:state': {
    readonly state: 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed';
    readonly attempt: number;
    readonly nextRetryMs?: number;
  };

  /* 通用錯誤 / 通知（UI 依 code 呈現） */
  'app:error': AppErrorInfo;
  'app:notice': { readonly level: 'info' | 'warning'; readonly message: string; readonly code?: string };
}

/* ------------------------------------------------------------------ */
/* Main only                                                           */
/* ------------------------------------------------------------------ */

export interface MainEvents {
  'stt:audioChunk': { readonly utteranceId: UtteranceId; readonly pcm: Float32Array };
  'stt:utteranceEnd': { readonly utteranceId: UtteranceId };
  'stt:utteranceCancel': { readonly utteranceId: UtteranceId };
  'tts:enqueue': { readonly turnId: TurnId; readonly seq: number; readonly text: string };
  'memory:turnAppended': { readonly turnId: TurnId };
  'app:idle': { readonly idleSeconds: number };
  'app:beforeQuit': void;
}

/* ------------------------------------------------------------------ */
/* Renderer only                                                       */
/* ------------------------------------------------------------------ */

export interface RendererEvents {
  'render:frame': { readonly dt: number };
  'interaction:dragStart': void;
  'interaction:dragEnd': void;
  'interaction:hoverChanged': { readonly overAvatar: boolean };
  'lipsync:level': { readonly level: number };
}

export type MainEventMap = SharedEvents & MainEvents;
export type RendererEventMap = SharedEvents & RendererEvents;

/** 編譯期檢查：三組事件名稱不得重複。 */
type Overlap<A, B> = Extract<keyof A, keyof B>;
type AssertNever<T extends never> = T;
export type _NoOverlapSM = AssertNever<Overlap<SharedEvents, MainEvents>>;
export type _NoOverlapSR = AssertNever<Overlap<SharedEvents, RendererEvents>>;
export type _NoOverlapMR = AssertNever<Overlap<MainEvents, RendererEvents>>;
