import type { WhisperComputeType, WhisperConfig, WhisperDevice, WhisperModelSize } from '../config/schema';
import type { UtteranceId } from '../types/domain';

/** 16 kHz、mono、Float32 [-1, 1] 的 PCM。STT 一律使用此格式。 */
export const STT_SAMPLE_RATE = 16000 as const;

export interface WhisperSelection {
  readonly modelSize: WhisperModelSize;
  readonly device: WhisperDevice;
  readonly computeType: WhisperComputeType;
}

export interface DownloadProgress {
  readonly modelSize: WhisperModelSize;
  readonly downloadedBytes: number;
  /** 未知時為 null（某些 HF 下載後端不回報總量）。 */
  readonly totalBytes: number | null;
  /** 0–1；totalBytes 為 null 時為 null。 */
  readonly fraction: number | null;
  readonly file?: string;
}

export type SttStatus =
  | { readonly kind: 'unloaded' }
  | { readonly kind: 'downloading'; readonly target: WhisperSelection; readonly progress: DownloadProgress }
  | { readonly kind: 'loading'; readonly target: WhisperSelection }
  | {
      readonly kind: 'ready';
      /** 實際生效的設定（CUDA 不可用時會與請求不同）。 */
      readonly active: WhisperSelection;
      /** 若發生自動降級（例如 cuda→cpu/int8），說明原因。 */
      readonly fallbackReason?: string;
    }
  | { readonly kind: 'error'; readonly message: string; readonly active: WhisperSelection | null };

export interface SttLoadResult {
  readonly active: WhisperSelection;
  readonly fallbackReason?: string;
  readonly loadMs: number;
}

export interface SttResult {
  readonly utteranceId: UtteranceId;
  readonly text: string;
  readonly language: string;
  readonly languageProbability: number;
  /** 音訊長度（ms）。 */
  readonly audioMs: number;
  /** 辨識耗時（ms）。 */
  readonly elapsedMs: number;
  /** VAD 過濾後沒有語音。 */
  readonly empty: boolean;
}

export interface UtteranceHandle {
  readonly id: UtteranceId;
  /** 送入一塊 16 kHz Float32 PCM。 */
  push(chunk: Float32Array): void;
  /** 結束錄音並取得結果。 */
  end(): Promise<SttResult>;
  /** 放棄這段錄音（例如使用者取消、被 TTS 播放打斷）。 */
  cancel(): void;
}

/**
 * 語音轉文字提供者。實作：SidecarSTTProvider（第 5 階段）。
 * 規範：
 * - `load()` 失敗時必須保留舊模型可用（熱切換失敗回退）。
 * - `load()` 接受 AbortSignal 以取消下載；取消後狀態回到切換前。
 */
export interface STTProvider {
  readonly id: string;
  status(): SttStatus;
  load(
    cfg: Pick<WhisperConfig, 'modelSize' | 'device' | 'computeType' | 'downloadRoot'>,
    opts?: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal },
  ): Promise<SttLoadResult>;
  beginUtterance(opts: {
    id: UtteranceId;
    language: string;
    initialPrompt: string;
    beamSize: number;
  }): UtteranceHandle;
  /** 列出已下載到本機的模型大小（供 UI 標示「需下載」）。 */
  listDownloaded(): Promise<readonly WhisperModelSize[]>;
  /** 是否偵測到可用的 CUDA 裝置。 */
  cudaAvailable(): Promise<boolean>;
}
