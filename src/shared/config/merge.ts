/**
 * 設定深度合併與差異計算（純函式）。
 *
 * 合併規則：
 * - plain object：遞迴合併
 * - 陣列：整個替換（outfits 等清單由 UI 送完整陣列）
 * - `undefined`：忽略（不覆蓋）
 * - `null`：只有在目標欄位是 optional 時才有意義；這裡視為「刪除該 key」，交給 zod 補預設
 * - 原型污染防護：忽略 __proto__ / constructor / prototype
 */
import { AppConfigSchema, type AppConfig, type AppConfigPatch } from './schema';
import { z } from 'zod';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return structuredClone(patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v === undefined) continue;
    if (v === null) {
      Reflect.deleteProperty(out, k);
      continue;
    }
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : isPlainObject(v) || Array.isArray(v) ? structuredClone(v) : v;
  }
  return out as T;
}

/** 回傳兩個值之間有差異的葉節點路徑（例如 "llm.model"、"avatar.outfits"）。陣列視為葉節點。 */
export function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (Object.is(a, b)) return [];
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: string[] = [];
    for (const k of keys) out.push(...diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))) {
    return [];
  }
  return [prefix || '(root)'];
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return diffPaths(a, b).length === 0;
}

export type ApplyPatchResult =
  | { ok: true; next: AppConfig; changedPaths: string[] }
  | { ok: false; error: string; issues: z.core.$ZodIssue[] };

/** 將 patch 套用到目前設定並以完整 schema 驗證。失敗時不改變任何東西。 */
export function applyConfigPatch(current: AppConfig, patch: AppConfigPatch | Record<string, unknown>): ApplyPatchResult {
  const merged = deepMerge(current, patch);
  const r = AppConfigSchema.safeParse(merged);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error), issues: r.error.issues };
  return { ok: true, next: r.data, changedPaths: diffPaths(current, r.data) };
}

/**
 * 載入磁碟上的設定：盡量保留可用區塊。
 * 整體驗證失敗時，逐個頂層區塊驗證，失敗的區塊回退為預設值並回報。
 */
export function loadConfigLenient(raw: unknown): { config: AppConfig; resetSections: string[] } {
  const full = AppConfigSchema.safeParse(raw ?? {});
  if (full.success) return { config: full.data, resetSections: [] };

  const input = isPlainObject(raw) ? raw : {};
  const shape = AppConfigSchema.shape;
  const repaired: Record<string, unknown> = {};
  const resetSections: string[] = [];
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    const section = shape[key].safeParse(input[key]);
    if (section.success) repaired[key] = section.data;
    else resetSections.push(key);
  }
  // 被回退的區塊交給 schema 補預設值
  for (const k of resetSections) Reflect.deleteProperty(repaired, k);
  return { config: AppConfigSchema.parse(repaired), resetSections };
}

/** 判斷變更路徑是否落在某區塊下（例如 isUnder(paths, 'stt.whisper')）。 */
export function isUnder(paths: readonly string[], prefix: string): boolean {
  return paths.some((p) => p === prefix || p.startsWith(`${prefix}.`));
}
