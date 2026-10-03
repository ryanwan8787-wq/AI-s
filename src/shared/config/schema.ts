/**
 * 單一設定 schema（zod 4）。
 *
 * 原則：
 * - 所有欄位都有預設值 → `AppConfigSchema.parse({})` 會得到一份完整可用的設定。
 * - main 程序是唯一寫入者（config.json 位於 app.getPath('userData')）；
 *   renderer 只能透過 IPC `config:patch` 送出 Partial，由 main 深度合併後重新驗證。
 * - 每個欄位標註 `hot`（熱更新即生效）或 `restart`（需重啟）。見 CONFIG_HOT_RELOAD。
 * - 版本號 `schemaVersion` 供未來 migration 使用。
 */
import { z } from 'zod';

export const CONFIG_SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* 列舉                                                                */
/* ------------------------------------------------------------------ */

/** faster-whisper 1.2.1 內建別名（utils._MODELS）中本專案開放的子集。large-v3-turbo 於 1.2.1 已確認存在。 */
export const WhisperModelSize = z.enum(['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo']);
export type WhisperModelSize = z.infer<typeof WhisperModelSize>;

export const WhisperDevice = z.enum(['cuda', 'cpu']);
export type WhisperDevice = z.infer<typeof WhisperDevice>;

/** CTranslate2 compute_type 子集。cpu 上 float16 不支援 → 由 sidecar 自動改為 int8 並回報。 */
export const WhisperComputeType = z.enum(['float16', 'int8_float16', 'int8']);
export type WhisperComputeType = z.infer<typeof WhisperComputeType>;

export const SttMode = z.enum(['push_to_talk', 'continuous_vad']);
export type SttMode = z.infer<typeof SttMode>;

export const LipSyncMode = z.enum(['spectral', 'volume']);
export type LipSyncMode = z.infer<typeof LipSyncMode>;

export const RendererKind = z.enum(['vrm', 'live2d']); // live2d 僅 stub
export type RendererKind = z.infer<typeof RendererKind>;

export const HardwarePreset = z.enum(['low', 'mid', 'high', 'custom']);
export type HardwarePreset = z.infer<typeof HardwarePreset>;

/* ------------------------------------------------------------------ */
/* 共用小型 schema                                                     */
/* ------------------------------------------------------------------ */

/** Electron Accelerator 字串，例如 "Alt+Space"、"CommandOrControl+Shift+M"；空字串 = 停用。 */
const Accelerator = z.string().max(64);

/** 僅允許 loopback，避免把對話內容送往區網或外部。 */
const LoopbackHttpUrl = z
  .url({ protocol: /^https?$/ })
  .refine((u) => {
    // z.url() 失敗時 refine 仍會被呼叫（zod 4 預設非 abort），因此 URL 解析必須安全
    const host = URL.canParse(u) ? new URL(u).hostname : '';
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  }, 'Ollama 位址僅允許 127.0.0.1 / localhost / [::1]');

/** Edge TTS 語音短名，例如 zh-TW-HsiaoChenNeural。格式寬鬆驗證，實際可用清單由 sidecar `tts.list_voices` 提供。 */
const EdgeVoiceName = z.string().regex(/^[a-z]{2,3}-[A-Z]{2,4}(-[A-Za-z]+)?-[A-Za-z]+Neural$/);

/** Edge TTS 的 rate / pitch / volume 字串格式，例如 "+0%"、"-10%"、"+0Hz"。 */
const SignedPercent = z.string().regex(/^[+-]\d{1,3}%$/);
const SignedHz = z.string().regex(/^[+-]\d{1,3}Hz$/);

/* ------------------------------------------------------------------ */
/* LLM                                                                 */
/* ------------------------------------------------------------------ */

export const ModelProfileSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).default(0.9),
  /** Ollama options.num_ctx。記憶注入的 token 預算會依此自動縮減。 */
  numCtx: z.number().int().min(1024).max(262144).default(8192),
  /** Ollama options.num_predict；-1 = 不限制。 */
  numPredict: z.number().int().min(-1).max(8192).default(512),
  /**
   * 是否在請求中送出 `think: false`。
   * - true  → 送 think:false（Qwen3 系列等 thinking 模型建議開啟，避免延遲與格式干擾）
   * - false → 不送 think 欄位（非 thinking 模型送了可能會回 400，需驗證）
   */
  sendThinkFalse: z.boolean().default(true),
  /** 最近一次 schema 相容性測試結果（main 寫入，UI 顯示）。 */
  lastSchemaCheck: z
    .object({ ok: z.boolean(), at: z.iso.datetime(), message: z.string().max(500).optional() })
    .optional(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const LlmConfigSchema = z.object({
  ollamaBaseUrl: LoopbackHttpUrl.default('http://127.0.0.1:11434'),
  /** 目前使用的模型 tag。預設值可改；未安裝時首次啟動引導使用者從 /api/tags 清單選擇。 */
  model: z.string().min(1).max(200).default('qwen3.8:27b'),
  /** 最近一個通過 schema 測試的模型；切換失敗時退回用。 */
  lastGoodModel: z.string().max(200).optional(),
  /** key = 模型 tag（例如 "qwen3:8b"）。不存在的 key 以 ModelProfileSchema 預設值補齊。 */
  modelProfiles: z.record(z.string().min(1).max(200), ModelProfileSchema).default({}),
  /** Ollama keep_alive（秒或 duration 字串）。常駐型應用建議較長，避免每次冷啟。 */
  keepAlive: z.union([z.number().int().min(-1), z.string().regex(/^\d+(ms|s|m|h)$/)]).default('30m'),
  requestTimeoutMs: z.number().int().min(5000).max(600000).default(120000),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/* ------------------------------------------------------------------ */
/* 語音                                                                */
/* ------------------------------------------------------------------ */

export const WhisperConfigSchema = z.object({
  modelSize: WhisperModelSize.default('small'),
  device: WhisperDevice.default('cuda'),
  computeType: WhisperComputeType.default('float16'),
  /** Whisper 語言提示；'auto' = 自動偵測。預設 zh 以提升繁中辨識穩定度（輸出簡繁由後處理轉換，於階段 5 說明）。 */
  language: z.string().max(8).default('zh'),
  beamSize: z.number().int().min(1).max(10).default(1),
  /** 傳給 faster-whisper 的 initial_prompt，可引導輸出繁體字與專有名詞。 */
  initialPrompt: z.string().max(500).default('以下是繁體中文的日常對話。'),
  /** 模型下載/快取目錄；空字串 = sidecar 使用 userData/models/whisper。 */
  downloadRoot: z.string().max(1024).default(''),
  /** 最近一組成功載入的設定（熱切換失敗時退回）。 */
  lastGood: z
    .object({ modelSize: WhisperModelSize, device: WhisperDevice, computeType: WhisperComputeType })
    .optional(),
});
export type WhisperConfig = z.infer<typeof WhisperConfigSchema>;

export const SttConfigSchema = z.object({
  mode: SttMode.default('push_to_talk'),
  /** 前端 VAD（持續監聽）參數；最終分段仍由 faster-whisper 內建 Silero VAD 過濾。 */
  vad: z
    .object({
      threshold: z.number().min(0.05).max(0.95).default(0.5),
      minSilenceMs: z.number().int().min(100).max(3000).default(600),
      minSpeechMs: z.number().int().min(50).max(2000).default(250),
      maxUtteranceSec: z.number().min(2).max(60).default(20),
    })
    .prefault({}),
  /** 使用者開口時打斷 TTS 播放。 */
  bargeIn: z.boolean().default(true),
  /**
   * 播放 TTS 時的防回授策略：
   * - pause_capture：播放期間暫停送音訊給 STT（最穩，預設；此時 barge-in 改以能量門檻偵測）
   * - echo_cancellation：依賴 getUserMedia 的 echoCancellation（Chromium AEC 對系統播放的效果需驗證）
   */
  echoStrategy: z.enum(['pause_capture', 'echo_cancellation']).default('pause_capture'),
  /** 麥克風裝置 ID；空字串 = 系統預設。 */
  inputDeviceId: z.string().max(256).default(''),
  whisper: WhisperConfigSchema.prefault({}),
});
export type SttConfig = z.infer<typeof SttConfigSchema>;

export const TtsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  voice: EdgeVoiceName.default('zh-TW-HsiaoChenNeural'),
  rate: SignedPercent.default('+0%'),
  pitch: SignedHz.default('+0Hz'),
  volume: SignedPercent.default('+0%'),
  /** 輸出音量（renderer 端 GainNode，0–1）。 */
  outputGain: z.number().min(0).max(1).default(0.9),
  /** 逐句切分的最短字數，太短的句子會與下一句合併以減少 TTS 請求數。 */
  minSentenceChars: z.number().int().min(1).max(50).default(6),
  outputDeviceId: z.string().max(256).default(''),
});
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

export const LipSyncConfigSchema = z.object({
  mode: LipSyncMode.default('spectral'),
  noiseGateDb: z.number().min(-100).max(0).default(-50),
  attackMs: z.number().min(5).max(200).default(40),
  releaseMs: z.number().min(20).max(500).default(100),
  gain: z.number().min(0.1).max(4).default(1.2),
});
export type LipSyncConfig = z.infer<typeof LipSyncConfigSchema>;

/* ------------------------------------------------------------------ */
/* 角色 / 渲染                                                         */
/* ------------------------------------------------------------------ */

export const OutfitSchema = z.object({
  /** 供 LLM 輸出 outfitId 使用，只允許安全字元。 */
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().min(1).max(40),
  /** 本機 .vrm 絕對路徑。 */
  vrmPath: z.string().min(1).max(1024),
});
export type Outfit = z.infer<typeof OutfitSchema>;

export const AvatarConfigSchema = z.object({
  renderer: RendererKind.default('vrm'),
  /** 目前角色 VRM 路徑；空字串 = 尚未選擇（顯示引導畫面，不內建任何有版權模型）。 */
  vrmPath: z.string().max(1024).default(''),
  outfits: z.array(OutfitSchema).max(32).default([]),
  activeOutfitId: z.string().max(32).optional(),
  /** VRMA 動作檔覆寫：key = action 名稱，value = .vrma 路徑。未指定則使用程序化動畫。 */
  vrmaOverrides: z.record(z.string(), z.string().max(1024)).default({}),
  scale: z.number().min(0.3).max(3).default(1),
  eyeTracking: z
    .object({
      enabled: z.boolean().default(true),
      pollHz: z.number().int().min(30).max(60).default(30),
      maxYawDeg: z.number().min(0).max(60).default(35),
      maxPitchDeg: z.number().min(0).max(40).default(20),
      /** 權重總和不需為 1；分別乘上目標角度。 */
      weights: z
        .object({
          eyes: z.number().min(0).max(1).default(1),
          neck: z.number().min(0).max(1).default(0.35),
          head: z.number().min(0).max(1).default(0.45),
        })
        .prefault({}),
      /** MathUtils.damp 的 lambda。 */
      damping: z.number().min(1).max(30).default(8),
    })
    .prefault({}),
});
export type AvatarConfig = z.infer<typeof AvatarConfigSchema>;

/* ------------------------------------------------------------------ */
/* 人設 / 記憶 / 主動搭話                                              */
/* ------------------------------------------------------------------ */

export const PersonaSchema = z.object({
  name: z.string().min(1).max(20).default('小晴'),
  userCallName: z.string().min(1).max(20).default('你'),
  personality: z.string().max(300).default('溫和、細心、有點幽默；會關心對方但不嘮叨。'),
  speakingStyle: z
    .string()
    .max(300)
    .default('台灣口語，句子短，一次一到三句。不用疊字、不裝可愛、不用誇張敬語。'),
  taboos: z
    .string()
    .max(300)
    .default('不說教、不情緒勒索、不假裝有真實身體經驗、不詢問或記錄密碼與卡號。'),
  /** 進階：附加到 system prompt 的自由文字（會計入 token 預算）。 */
  extra: z.string().max(1000).default(''),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** 短期：送入 LLM 的最近輪數（1 輪 = user + assistant）。 */
  shortTermTurns: z.number().int().min(1).max(50).default(8),
  /** 每 M 輪觸發一次摘要/抽取。 */
  summarizeEveryTurns: z.number().int().min(2).max(100).default(10),
  /** 閒置多久（分鐘）觸發摘要。 */
  summarizeOnIdleMinutes: z.number().int().min(1).max(240).default(10),
  topK: z.number().int().min(0).max(30).default(6),
  /** 長期記憶注入的 token 上限；實際值 = min(此值, numCtx * memoryCtxRatio)。 */
  maxInjectTokens: z.number().int().min(0).max(8000).default(800),
  memoryCtxRatio: z.number().min(0.02).max(0.3).default(0.12),
  /**
   * 相關度計算：
   * - lexical：SQLite FTS5 (trigram) + 時間衰減 + 重要度（預設，零額外模型）
   * - embedding：經 Ollama /api/embed 取向量（需另外安裝 embedding 模型，例如 bge-m3）
   */
  retrieval: z.enum(['lexical', 'embedding']).default('lexical'),
  embeddingModel: z.string().max(200).default('bge-m3'),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/** "HH:MM"（24 小時制）。 */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const ProactiveConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** 兩次主動搭話的最短間隔。 */
  minIntervalMinutes: z.number().int().min(5).max(1440).default(45),
  maxPerDay: z.number().int().min(0).max(50).default(6),
  doNotDisturb: z.boolean().default(false),
  quietHours: z
    .object({ enabled: z.boolean().default(true), start: HHMM.default('23:00'), end: HHMM.default('08:00') })
    .prefault({}),
  /** 偵測到前景程式為全螢幕時不搭話。 */
  suppressWhenFullscreen: z.boolean().default(true),
});
export type ProactiveConfig = z.infer<typeof ProactiveConfigSchema>;

/* ------------------------------------------------------------------ */
/* 視窗 / 效能 / 快捷鍵 / 系統                                          */
/* ------------------------------------------------------------------ */

export const WindowConfigSchema = z.object({
  width: z.number().int().min(200).max(1600).default(420),
  height: z.number().int().min(300).max(2000).default(640),
  /** 上次位置（螢幕 DIP 座標）；缺省時置於主螢幕右下角。 */
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  /** 上次所在螢幕 id（多螢幕還原用；螢幕不存在時退回主螢幕）。 */
  displayId: z.number().int().optional(),
  alwaysOnTop: z.boolean().default(true),
  skipTaskbar: z.boolean().default(true),
  /** 命中測試方式：raycast = 對 mesh 做射線；alpha = 讀取 1px 像素 alpha（較準但每次需 readPixels）。 */
  hitTest: z.enum(['raycast', 'alpha']).default('alpha'),
});
export type WindowConfig = z.infer<typeof WindowConfigSchema>;

export const PerformanceConfigSchema = z.object({
  fpsActive: z.number().int().min(15).max(144).default(60),
  fpsIdle: z.number().int().min(5).max(60).default(30),
  /** 被全螢幕程式遮住時的 FPS；0 = 暫停渲染。 */
  fpsOccluded: z.number().int().min(0).max(10).default(5),
  idleAfterSeconds: z.number().int().min(5).max(600).default(20),
  pixelRatioCap: z.number().min(0.5).max(2).default(1.5),
  antialias: z.boolean().default(true),
});
export type PerformanceConfig = z.infer<typeof PerformanceConfigSchema>;

export const HotkeysConfigSchema = z.object({
  /** 全域 push-to-talk。Electron globalShortcut 無 keyup 事件 → 需 uiohook-napi（optional），缺少時改為「按一下開始/再按一下結束」。 */
  pushToTalk: Accelerator.default('Alt+Space'),
  toggleVisible: Accelerator.default('CommandOrControl+Alt+H'),
  toggleMute: Accelerator.default('CommandOrControl+Alt+M'),
  openSettings: Accelerator.default('CommandOrControl+Alt+S'),
});
export type HotkeysConfig = z.infer<typeof HotkeysConfigSchema>;

export const SidecarConfigSchema = z.object({
  /** 0 = 由 OS 指派空閒埠（sidecar 啟動後回報實際埠）。 */
  port: z.number().int().min(0).max(65535).default(0),
  /** 開發模式下可指定 python 執行檔；打包版使用內建的 PyInstaller 產物。 */
  pythonPath: z.string().max(1024).default(''),
  maxRestarts: z.number().int().min(0).max(100).default(8),
  restartBackoffBaseMs: z.number().int().min(100).max(10000).default(1000),
  restartBackoffMaxMs: z.number().int().min(1000).max(300000).default(60000),
});
export type SidecarConfig = z.infer<typeof SidecarConfigSchema>;

export const SystemConfigSchema = z.object({
  launchAtLogin: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  logMaxSizeMB: z.number().int().min(1).max(100).default(10),
  logMaxFiles: z.number().int().min(1).max(20).default(5),
  memoryUsageLogIntervalSec: z.number().int().min(30).max(3600).default(300),
  /** 首次啟動精靈（硬體偵測、模型選擇、VRM 選擇）是否已完成。 */
  onboardingDone: z.boolean().default(false),
  hardwarePreset: HardwarePreset.default('custom'),
});
export type SystemConfig = z.infer<typeof SystemConfigSchema>;

/* ------------------------------------------------------------------ */
/* 根 schema                                                           */
/* ------------------------------------------------------------------ */

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
  llm: LlmConfigSchema.prefault({}),
  stt: SttConfigSchema.prefault({}),
  tts: TtsConfigSchema.prefault({}),
  lipSync: LipSyncConfigSchema.prefault({}),
  avatar: AvatarConfigSchema.prefault({}),
  persona: PersonaSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
  proactive: ProactiveConfigSchema.prefault({}),
  window: WindowConfigSchema.prefault({}),
  performance: PerformanceConfigSchema.prefault({}),
  hotkeys: HotkeysConfigSchema.prefault({}),
  sidecar: SidecarConfigSchema.prefault({}),
  system: SystemConfigSchema.prefault({}),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
/** 寫入前（尚未補預設值）的輸入型別。 */
export type AppConfigInput = z.input<typeof AppConfigSchema>;

/** 深度 Partial，用於 IPC `config:patch`。 */
export type DeepPartial<T> = T extends readonly (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type AppConfigPatch = DeepPartial<AppConfig>;

export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({});

/** 取得模型的 profile，未設定時回傳預設值（不寫回 config）。 */
export function resolveModelProfile(cfg: LlmConfig, model: string): ModelProfile {
  return ModelProfileSchema.parse(cfg.modelProfiles[model] ?? {});
}

/**
 * 熱更新對照表：頂層區塊 → 生效方式。
 * - 'hot'：main 廣播 `config:changed`，訂閱者即時套用
 * - 'sidecar-reload'：需要 sidecar 重新載入（不重啟程序）
 * - 'restart'：需重啟 app（UI 顯示提示）
 */
export const CONFIG_HOT_RELOAD: Readonly<Record<keyof AppConfig, 'hot' | 'sidecar-reload' | 'restart'>> = {
  schemaVersion: 'restart',
  llm: 'hot', // 模型切換走 unload → preload → schema check 流程
  stt: 'sidecar-reload', // whisper.* 觸發熱切換；mode/vad 為 hot
  tts: 'hot',
  lipSync: 'hot',
  avatar: 'hot', // VRM 切換失敗時保留原角色
  persona: 'hot',
  memory: 'hot',
  proactive: 'hot',
  window: 'hot',
  performance: 'hot', // antialias 例外：需重建 WebGLRenderer（由 renderer 內部處理）
  hotkeys: 'hot',
  sidecar: 'restart',
  system: 'hot',
};
