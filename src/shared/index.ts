/**
 * shared 的公開入口。各模組只能 import 這裡（或 shared 子路徑）的型別與純函式，
 * 不得 import 其他模組的實作（見 docs/ARCHITECTURE.md §3）。
 */
export * from './types/domain';
export * from './types/errors';
export * from './config/schema';
export * from './config/merge';
export * from './ai/AIResponse';
export * from './events/EventMap';
export * from './events/TypedEventBus';
export * from './events/IpcBridge';
export * from './ipc/channels';
export type * from './providers/stt';
export { STT_SAMPLE_RATE } from './providers/stt';
export type * from './providers/tts';
export type * from './providers/llm';
export type * from './providers/gpu';
export type * from './providers/memory';
export { MEMORY_KINDS } from './providers/memory';
export type * from './providers/avatar';
export { EXPRESSION_LAYERS, POSE_LAYERS, HUMANOID_BONES } from './providers/avatar';
