/**
 * LLM 結構化輸出的契約。
 *
 * 欄位順序 = JSON Schema `properties` 順序 = 期望的輸出順序：
 *   emotion → action → outfitId → reply
 * 這樣表情與動作會先於語音被解析出來（第 7 階段的增量解析器依此降低延遲）。
 *
 * outfitId 的合法值每次請求都不同（取決於使用者設定的服裝清單），
 * 因此 schema 透過工廠函式動態產生；清單為空時直接移除該欄位，避免模型亂填。
 */
import { z } from 'zod';
import { AVATAR_ACTIONS, EMOTIONS, type AvatarAction, type Emotion } from '../types/domain';

export interface AIResponse {
  emotion: Emotion;
  action?: AvatarAction;
  /** 必須來自 system prompt 動態提供的可用清單。 */
  outfitId?: string;
  reply: string;
}

/** reply 長度上限：避免模型失控輸出長文造成 TTS 排隊過長。 */
export const REPLY_MAX_CHARS = 600;

export const EmotionSchema = z.enum(EMOTIONS);
export const AvatarActionSchema = z.enum(AVATAR_ACTIONS);

/**
 * 建立 AIResponse 的 zod schema。
 * @param outfitIds 本次可用的 outfit id；空陣列 → schema 不含 outfitId。
 */
export function createAIResponseSchema(outfitIds: readonly string[] = []) {
  const unique = [...new Set(outfitIds)];
  const base = {
    emotion: EmotionSchema,
    action: AvatarActionSchema.optional(),
  };
  const reply = { reply: z.string().max(REPLY_MAX_CHARS) };
  if (unique.length === 0) {
    return z.strictObject({ ...base, ...reply });
  }
  const [first, ...rest] = unique as [string, ...string[]];
  return z.strictObject({ ...base, outfitId: z.enum([first, ...rest]).optional(), ...reply });
}

/**
 * 產生傳給 Ollama `format` 參數的 JSON Schema。
 * - 移除 `$schema` 欄位：Ollama 不需要，且某些版本的 grammar 轉換器對未知關鍵字較敏感【需驗證】。
 * - reply 的 maxLength 保留：llama.cpp grammar 對字串長度的支援程度依版本而異【需驗證】，
 *   無論如何 zod 會在解析後再檢查一次。
 */
export function createAIResponseJsonSchema(outfitIds: readonly string[] = []): Record<string, unknown> {
  const json = z.toJSONSchema(createAIResponseSchema(outfitIds)) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = json;
  return rest;
}

export interface ParsedAIResponse {
  readonly response: AIResponse;
  /** 是否走了降級路徑（解析或驗證失敗）。 */
  readonly degraded: boolean;
  /** 被忽略的欄位與原因（例如非法 outfitId），供 log 使用。 */
  readonly dropped: readonly { field: keyof AIResponse; value: unknown; reason: string }[];
}

/**
 * 將模型輸出的完整文字轉為 AIResponse，**永不 throw**。
 *
 * 規則：
 * 1. JSON 解析成功且通過 schema → 原樣使用。
 * 2. JSON 解析成功但個別欄位不合法 → 逐欄修補：
 *    - emotion 不合法 → 'idle'
 *    - action 不合法 → 移除
 *    - outfitId 不在清單 → 一律移除（需求：非法 outfitId 一律忽略）
 *    - reply 非字串 → 降級為原始文字
 *    - 多餘欄位 → 移除
 * 3. 不是 JSON → `{ emotion: 'idle', reply: <原始文字> }`。
 */
export function parseAIResponse(raw: string, outfitIds: readonly string[] = []): ParsedAIResponse {
  const allowedOutfits = new Set(outfitIds);
  const dropped: { field: keyof AIResponse; value: unknown; reason: string }[] = [];
  const fallbackReply = clampReply(stripCodeFence(raw).trim());

  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(raw));
  } catch {
    return { response: { emotion: 'idle', reply: fallbackReply }, degraded: true, dropped };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { response: { emotion: 'idle', reply: fallbackReply }, degraded: true, dropped };
  }

  const strict = createAIResponseSchema(outfitIds).safeParse(data);
  if (strict.success) {
    return { response: strict.data as AIResponse, degraded: false, dropped };
  }

  // 逐欄修補
  const obj = data as Record<string, unknown>;
  let degraded = false;

  let reply: string;
  if (typeof obj['reply'] === 'string') {
    reply = clampReply(obj['reply']);
    if (reply.length !== obj['reply'].length) dropped.push({ field: 'reply', value: '[truncated]', reason: 'too long' });
  } else {
    reply = fallbackReply;
    degraded = true;
  }

  const em = EmotionSchema.safeParse(obj['emotion']);
  const emotion: Emotion = em.success ? em.data : 'idle';
  if (!em.success) {
    dropped.push({ field: 'emotion', value: obj['emotion'], reason: 'invalid emotion' });
    degraded = true;
  }

  const response: AIResponse = { emotion, reply };

  if (obj['action'] !== undefined) {
    const ac = AvatarActionSchema.safeParse(obj['action']);
    if (ac.success) response.action = ac.data;
    else dropped.push({ field: 'action', value: obj['action'], reason: 'invalid action' });
  }

  if (obj['outfitId'] !== undefined) {
    if (typeof obj['outfitId'] === 'string' && allowedOutfits.has(obj['outfitId'])) {
      response.outfitId = obj['outfitId'];
    } else {
      dropped.push({ field: 'outfitId', value: obj['outfitId'], reason: 'not in allowed outfit list' });
    }
  }

  return { response, degraded, dropped };
}

/** 有些模型即使給了 format 仍會包 ```json fence；容忍之。 */
function stripCodeFence(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(s);
  return m?.[1] ?? s;
}

function clampReply(s: string): string {
  return s.length > REPLY_MAX_CHARS ? s.slice(0, REPLY_MAX_CHARS) : s;
}
