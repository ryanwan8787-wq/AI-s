/**
 * 跨程序共用的領域常數與型別。只放「純資料」，不得 import 任何執行期實作。
 * 所有列舉以 `as const` 陣列定義，讓 zod schema、JSON Schema 與 TS 型別共用同一份來源。
 */

/* ------------------------------ 情緒 / 動作 ------------------------------ */

/** LLM 可輸出的情緒（AIResponse.emotion）。 */
export const EMOTIONS = ['idle', 'happy', 'shy', 'caring', 'annoyed', 'surprised'] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** LLM 可要求的一次性動作（AIResponse.action）。 */
export const AVATAR_ACTIONS = ['nod', 'head_pat_react', 'wave', 'stretch', 'leave', 'return'] as const;
export type AvatarAction = (typeof AVATAR_ACTIONS)[number];

/** 內部才會觸發的動作（不開放給 LLM）。 */
export const INTERNAL_ACTIONS = ['body_touch_react', 'thinking_idle'] as const;
export type InternalAction = (typeof INTERNAL_ACTIONS)[number];

export type AnyAction = AvatarAction | InternalAction;

/* ------------------------------ VRM 表情 ------------------------------ */

/** 口型使用的 VRM 1.0 母音 preset。VRM 0.x 的 a/i/u/e/o 由 three-vrm 載入時映射。 */
export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
export type Viseme = (typeof VISEMES)[number];

/** VRM 1.0 表情 preset 名稱（VRMC_vrm-1.0 expressions.preset）。 */
export const VRM_EXPRESSION_PRESETS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
  'neutral',
] as const;
export type VrmExpressionPreset = (typeof VRM_EXPRESSION_PRESETS)[number];

/**
 * VRM 0.x BlendShape preset → VRM 1.0 preset。
 * three-vrm 3.x 的 VRMExpressionLoaderPlugin 已內建此映射；這裡保留一份供 Live2D stub /
 * 自訂表情名稱比對與單元測試使用。
 */
export const VRM0_TO_VRM1_PRESET: Readonly<Record<string, VrmExpressionPreset>> = {
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
  joy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  fun: 'relaxed',
  surprised: 'surprised',
  blink: 'blink',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
  lookup: 'lookUp',
  lookdown: 'lookDown',
  lookleft: 'lookLeft',
  lookright: 'lookRight',
  neutral: 'neutral',
};

/** 表情名稱可為 VRM preset 或模型自訂（custom）表情。 */
export type ExpressionKey = VrmExpressionPreset | (string & {});

/* ------------------------------ 角色狀態 ------------------------------ */

/**
 * AvatarController 狀態。
 * - leaving / away / returning：不接受互動
 * - modelSwitching：LLM 或 VRM 切換中，顯示思考待機，不接受新對話
 */
export const AVATAR_STATES = [
  'booting',
  'idle',
  'listening',
  'thinking',
  'speaking',
  'reacting',
  'leaving',
  'away',
  'returning',
  'modelSwitching',
] as const;
export type AvatarState = (typeof AVATAR_STATES)[number];

/** 互動判定結果。 */
export const GESTURES = ['click', 'longPress', 'dragStart', 'dragEnd'] as const;
export type Gesture = (typeof GESTURES)[number];

export const HIT_REGIONS = ['head', 'body'] as const;
export type HitRegion = (typeof HIT_REGIONS)[number];

/** 環形選單項目。 */
export const RADIAL_MENU_ITEMS = ['outfit', 'settings', 'mute', 'leave'] as const;
export type RadialMenuItem = (typeof RADIAL_MENU_ITEMS)[number];

/* ------------------------------ 對話 ------------------------------ */

/** 對話管線狀態（main 的 DialogueOrchestrator 擁有，renderer 鏡像）。 */
export const DIALOGUE_PHASES = ['idle', 'listening', 'transcribing', 'thinking', 'speaking'] as const;
export type DialoguePhase = (typeof DIALOGUE_PHASES)[number];

/** 一輪對話的識別碼（main 產生，單調遞增字串，便於 log 排序）。 */
export type TurnId = string & { readonly __brand: 'TurnId' };
export const asTurnId = (s: string): TurnId => s as TurnId;

/** 一段錄音（一次 PTT 或一次 VAD 片段）的識別碼（renderer 產生）。 */
export type UtteranceId = string & { readonly __brand: 'UtteranceId' };
export const asUtteranceId = (s: string): UtteranceId => s as UtteranceId;

/* ------------------------------ 視窗 / 渲染 ------------------------------ */

/** 渲染節流等級。 */
export const RENDER_ACTIVITY = ['active', 'idle', 'occluded', 'hidden'] as const;
export type RenderActivity = (typeof RENDER_ACTIVITY)[number];

export interface ScreenPoint {
  /** 螢幕 DIP 座標（Electron screen API 單位）。 */
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type Unsubscribe = () => void;
