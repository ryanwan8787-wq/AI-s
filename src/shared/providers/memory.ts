import type { TurnId } from '../types/domain';

export const MEMORY_KINDS = ['fact', 'preference', 'event'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface ConversationTurn {
  readonly id: TurnId;
  readonly userText: string;
  readonly assistantText: string;
  readonly emotion: string;
  readonly createdAt: string;
}

export interface MemoryItem {
  readonly id: number;
  readonly kind: MemoryKind;
  readonly content: string;
  /** 1–5，越高越常被注入。 */
  readonly importance: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly sourceTurnIds: readonly TurnId[];
  /** 使用者手動釘選：永遠優先注入。 */
  readonly pinned: boolean;
}

export interface MemoryDraft {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly importance: number;
  readonly sourceTurnIds?: readonly TurnId[];
  readonly pinned?: boolean;
}

export interface ScoredMemory {
  readonly item: MemoryItem;
  /** 0–1 綜合分數（相關度、重要度、時間衰減）。 */
  readonly score: number;
}

export interface MemorySearchOptions {
  readonly topK: number;
  /** 回傳的 content 總 token 估計上限。 */
  readonly tokenBudget: number;
}

export interface MemoryExport {
  readonly version: 1;
  readonly exportedAt: string;
  readonly memories: readonly MemoryItem[];
  readonly turns?: readonly ConversationTurn[];
}

/**
 * 記憶儲存。實作：SqliteMemoryStore（better-sqlite3 + FTS5 trigram，第 7 階段）。
 * 規範：
 * - `add` / `update` 前必須經過 SensitiveFilter；被攔截時回傳 null 而非 throw。
 * - 所有方法皆為同步語意包成 Promise，方便未來換成非同步儲存。
 */
export interface MemoryStore {
  appendTurn(turn: ConversationTurn): Promise<void>;
  recentTurns(limit: number): Promise<readonly ConversationTurn[]>;
  /** 自上次摘要以來的輪數。 */
  turnsSinceLastSummary(): Promise<number>;
  markSummarized(upToTurnId: TurnId): Promise<void>;

  add(draft: MemoryDraft): Promise<MemoryItem | null>;
  update(id: number, patch: Partial<MemoryDraft>): Promise<MemoryItem | null>;
  remove(id: number): Promise<boolean>;
  list(opts?: { kind?: MemoryKind; query?: string; limit?: number; offset?: number }): Promise<readonly MemoryItem[]>;
  search(query: string, opts: MemorySearchOptions): Promise<readonly ScoredMemory[]>;
  touch(ids: readonly number[]): Promise<void>;

  exportAll(includeTurns: boolean): Promise<MemoryExport>;
  clearAll(): Promise<void>;
}
