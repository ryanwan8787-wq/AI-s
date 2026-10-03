/**
 * 統一錯誤碼。每個碼對應 docs/ARCHITECTURE.md §4.12 降級矩陣的一列，
 * UI 依 code 決定提示文字與動作（重試、開設定、開說明連結）。
 *
 * 錯誤要跨 IPC 傳遞，因此一律用可序列化的 plain object（AppErrorInfo），
 * 不直接傳 Error 實例（Electron IPC 只保留 message）。
 */

export const ERROR_CODES = [
  // LLM / Ollama
  'OLLAMA_UNREACHABLE',
  'LLM_MODEL_NOT_FOUND',
  'LLM_MODEL_LOAD_FAILED',
  'LLM_VRAM_INSUFFICIENT',
  'LLM_SCHEMA_INCOMPATIBLE',
  'LLM_THINK_UNSUPPORTED',
  'LLM_TIMEOUT',
  'LLM_STREAM_ABORTED',
  'LLM_BAD_OUTPUT',
  // sidecar
  'SIDECAR_SPAWN_FAILED',
  'SIDECAR_CRASHED',
  'SIDECAR_AUTH_FAILED',
  'SIDECAR_GAVE_UP',
  'SIDECAR_TIMEOUT',
  // STT
  'MIC_PERMISSION_DENIED',
  'MIC_UNAVAILABLE',
  'STT_MODEL_DOWNLOAD_FAILED',
  'STT_MODEL_DOWNLOAD_CANCELLED',
  'STT_MODEL_LOAD_FAILED',
  'STT_CUDA_UNAVAILABLE',
  'STT_TRANSCRIBE_FAILED',
  // TTS
  'TTS_NETWORK',
  'TTS_VOICE_INVALID',
  'TTS_FAILED',
  // Avatar
  'VRM_LOAD_FAILED',
  'VRM_FILE_NOT_ALLOWED',
  'VRMA_LOAD_FAILED',
  // Memory / config / misc
  'MEMORY_DB_FAILED',
  'CONFIG_INVALID',
  'IPC_INVALID_PAYLOAD',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 嚴重度：決定 UI 呈現方式。 */
export type ErrorSeverity =
  | 'info' // 只記 log 或小圖示（例：LLM_BAD_OUTPUT 已降級）
  | 'warning' // 氣泡/toast，功能部分可用（例：TTS_NETWORK → 文字氣泡）
  | 'error'; // 需使用者處理（例：OLLAMA_UNREACHABLE）

export interface AppErrorInfo {
  readonly code: ErrorCode;
  readonly message: string;
  readonly severity: ErrorSeverity;
  /** 是否可由使用者按「重試」。 */
  readonly retryable: boolean;
  /** 額外細節（給 log / 進階檢視），必須可 JSON 序列化。 */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** 預設嚴重度與可重試性。個別呼叫端可覆寫。 */
export const ERROR_DEFAULTS: Readonly<Record<ErrorCode, { severity: ErrorSeverity; retryable: boolean }>> = {
  OLLAMA_UNREACHABLE: { severity: 'error', retryable: true },
  LLM_MODEL_NOT_FOUND: { severity: 'error', retryable: false },
  LLM_MODEL_LOAD_FAILED: { severity: 'error', retryable: true },
  LLM_VRAM_INSUFFICIENT: { severity: 'warning', retryable: false },
  LLM_SCHEMA_INCOMPATIBLE: { severity: 'error', retryable: false },
  LLM_THINK_UNSUPPORTED: { severity: 'info', retryable: true },
  LLM_TIMEOUT: { severity: 'warning', retryable: true },
  LLM_STREAM_ABORTED: { severity: 'info', retryable: false },
  LLM_BAD_OUTPUT: { severity: 'info', retryable: false },
  SIDECAR_SPAWN_FAILED: { severity: 'error', retryable: true },
  SIDECAR_CRASHED: { severity: 'warning', retryable: true },
  SIDECAR_AUTH_FAILED: { severity: 'error', retryable: true },
  SIDECAR_GAVE_UP: { severity: 'error', retryable: true },
  SIDECAR_TIMEOUT: { severity: 'warning', retryable: true },
  MIC_PERMISSION_DENIED: { severity: 'error', retryable: true },
  MIC_UNAVAILABLE: { severity: 'error', retryable: true },
  STT_MODEL_DOWNLOAD_FAILED: { severity: 'error', retryable: true },
  STT_MODEL_DOWNLOAD_CANCELLED: { severity: 'info', retryable: true },
  STT_MODEL_LOAD_FAILED: { severity: 'error', retryable: true },
  STT_CUDA_UNAVAILABLE: { severity: 'warning', retryable: false },
  STT_TRANSCRIBE_FAILED: { severity: 'warning', retryable: true },
  TTS_NETWORK: { severity: 'warning', retryable: true },
  TTS_VOICE_INVALID: { severity: 'error', retryable: false },
  TTS_FAILED: { severity: 'warning', retryable: true },
  VRM_LOAD_FAILED: { severity: 'error', retryable: false },
  VRM_FILE_NOT_ALLOWED: { severity: 'error', retryable: false },
  VRMA_LOAD_FAILED: { severity: 'warning', retryable: false },
  MEMORY_DB_FAILED: { severity: 'error', retryable: true },
  CONFIG_INVALID: { severity: 'warning', retryable: false },
  IPC_INVALID_PAYLOAD: { severity: 'error', retryable: false },
  INTERNAL: { severity: 'error', retryable: false },
};

export function makeError(
  code: ErrorCode,
  message: string,
  opts: { severity?: ErrorSeverity; retryable?: boolean; detail?: Record<string, unknown> } = {},
): AppErrorInfo {
  const d = ERROR_DEFAULTS[code];
  const base = { code, message, severity: opts.severity ?? d.severity, retryable: opts.retryable ?? d.retryable };
  return opts.detail === undefined ? base : { ...base, detail: opts.detail };
}

/** 將任意 throw 的值轉為 AppErrorInfo（保留既有 AppErrorInfo）。 */
export function toAppError(err: unknown, fallback: ErrorCode = 'INTERNAL'): AppErrorInfo {
  if (isAppErrorInfo(err)) return err;
  if (err instanceof AppError) return err.info;
  if (err instanceof Error) {
    return makeError(fallback, err.message, { detail: { name: err.name } });
  }
  return makeError(fallback, typeof err === 'string' ? err : 'Unknown error');
}

export function isAppErrorInfo(v: unknown): v is AppErrorInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['code'] === 'string' &&
    (ERROR_CODES as readonly string[]).includes(o['code']) &&
    typeof o['message'] === 'string' &&
    typeof o['severity'] === 'string' &&
    typeof o['retryable'] === 'boolean'
  );
}

/** 可 throw 的錯誤類別，攜帶 AppErrorInfo。只在同一程序內使用。 */
export class AppError extends Error {
  readonly info: AppErrorInfo;
  constructor(info: AppErrorInfo, options?: { cause?: unknown }) {
    super(info.message, options);
    this.name = `AppError(${info.code})`;
    this.info = info;
  }
  static of(code: ErrorCode, message: string, detail?: Record<string, unknown>): AppError {
    return new AppError(makeError(code, message, detail === undefined ? {} : { detail }));
  }
  get code(): ErrorCode {
    return this.info.code;
  }
}

/* ------------------------------ Result ------------------------------ */

export type Result<T, E = AppErrorInfo> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
