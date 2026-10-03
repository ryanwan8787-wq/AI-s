/**
 * LLM 提供者介面。形狀對應 Ollama REST API（docs/api.md, 2026-09），
 * 但不洩漏 HTTP 細節，未來可換成 llama.cpp server / LM Studio 等實作。
 */

export interface LlmModelInfo {
  /** 例如 "qwen3:8b"。 */
  readonly name: string;
  /** 磁碟大小（bytes），用於 VRAM 估算。 */
  readonly sizeBytes: number;
  readonly family?: string;
  /** 例如 "8.2B"。 */
  readonly parameterSize?: string;
  /** 例如 "Q4_K_M"。 */
  readonly quantization?: string;
  readonly modifiedAt?: string;
}

export interface LlmRunningModel {
  readonly name: string;
  readonly sizeBytes: number;
  /** 載入到 VRAM 的部分；< sizeBytes 代表部分 offload 到 CPU（會變慢）。 */
  readonly sizeVramBytes: number;
  readonly expiresAt?: string;
}

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string;
}

export interface LlmChatOptions {
  readonly temperature: number;
  readonly topP: number;
  readonly numCtx: number;
  readonly numPredict: number;
}

export interface LlmChatRequest {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  /** JSON Schema（Ollama `format`）；省略 = 自由文字（摘要等用途）。 */
  readonly format?: Record<string, unknown>;
  readonly options: LlmChatOptions;
  /** true → 送出 `think: false`；false → 不送 think 欄位。 */
  readonly sendThinkFalse: boolean;
  readonly keepAlive?: string | number;
}

export type LlmChunk =
  | { readonly type: 'delta'; readonly content: string }
  | {
      readonly type: 'done';
      readonly doneReason: string;
      readonly promptTokens?: number;
      readonly evalTokens?: number;
      readonly totalMs?: number;
    };

export interface LlmEmbedRequest {
  readonly model: string;
  readonly input: readonly string[];
}

/**
 * 規範：
 * - 連線失敗 throw AppError('OLLAMA_UNREACHABLE')；模型不存在 'LLM_MODEL_NOT_FOUND'。
 * - `chatStream` 在 signal abort 時結束迭代且不 throw。
 * - `load` 等價於 POST /api/chat {model, messages: []}（done_reason: "load"）。
 * - `unload` 等價於 POST /api/chat {model, messages: [], keep_alive: 0}。
 */
export interface LLMProvider {
  readonly id: string;
  /** 連線檢查並回傳 Ollama 版本字串（GET /api/version）。 */
  ping(signal?: AbortSignal): Promise<string>;
  listModels(signal?: AbortSignal): Promise<readonly LlmModelInfo[]>;
  runningModels(signal?: AbortSignal): Promise<readonly LlmRunningModel[]>;
  load(model: string, keepAlive?: string | number, signal?: AbortSignal): Promise<void>;
  unload(model: string, signal?: AbortSignal): Promise<void>;
  chatStream(req: LlmChatRequest, signal?: AbortSignal): AsyncIterable<LlmChunk>;
  /** 非串流版本（schema probe、摘要使用）。 */
  chat(req: LlmChatRequest, signal?: AbortSignal): Promise<{ content: string; doneReason: string }>;
  embed?(req: LlmEmbedRequest, signal?: AbortSignal): Promise<readonly Float32Array[]>;
}
