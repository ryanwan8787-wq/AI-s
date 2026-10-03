/**
 * 角色渲染器抽象。VrmRenderer（第 3 階段）與 Live2DRenderer stub（第 8 階段）實作此介面。
 *
 * 分層合成模型：
 *   每個 Controller 只寫入自己的 layer；渲染器在 `update()` 時依 LAYER_ORDER 合成。
 *   這讓「口型只覆蓋嘴部、不干擾其他層」成為結構保證，而非靠呼叫順序。
 */
import type { ExpressionKey, HitRegion } from '../types/domain';

/** 表情層（後者覆蓋前者；同一 key 依各層 blend 規則合成）。 */
export const EXPRESSION_LAYERS = ['idle', 'emotion', 'action', 'lipsync'] as const;
export type ExpressionLayer = (typeof EXPRESSION_LAYERS)[number];

/** 骨骼姿勢層（加算合成，依此順序套用）。 */
export const POSE_LAYERS = ['base', 'idle', 'action', 'lookAt'] as const;
export type PoseLayer = (typeof POSE_LAYERS)[number];

/** VRM Humanoid 骨骼名稱子集（VRM 1.0 命名，three-vrm 會自動映射 0.x）。 */
export const HUMANOID_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
] as const;
export type HumanoidBone = (typeof HUMANOID_BONES)[number];

/** 四元數 [x, y, z, w]；用 tuple 而非 THREE.Quaternion，讓 shared 不依賴 three。 */
export type QuatTuple = readonly [number, number, number, number];
export type Vec3Tuple = readonly [number, number, number];

export interface BonePose {
  /** 相對於 rest pose 的旋轉（加算）。 */
  readonly rotation?: QuatTuple;
  /** 只有 hips 使用：相對位移（公尺）。 */
  readonly position?: Vec3Tuple;
}

export type HumanoidPose = Partial<Record<HumanoidBone, BonePose>>;

export type ExpressionWeights = Partial<Record<ExpressionKey, number>>;

export interface HitResult {
  readonly region: HitRegion;
  /** 命中點的世界座標。 */
  readonly point: Vec3Tuple;
  readonly distance: number;
}

export interface AvatarModelInfo {
  /** 0 = VRM 0.x，1 = VRM 1.0；Live2D 為 null。 */
  readonly specVersion: '0.x' | '1.0' | null;
  readonly title?: string;
  readonly author?: string;
  /** 模型實際支援的表情 key（缺少的 key 寫入時會被靜默忽略）。 */
  readonly expressions: readonly ExpressionKey[];
  /** 模型實際擁有的骨骼。 */
  readonly bones: readonly HumanoidBone[];
  /** 頭頂到腳底高度（公尺），用於相機取景與 collider 尺寸。 */
  readonly heightM: number;
}

export interface LookAtTarget {
  /** 目標點（世界座標）；null = 回正。 */
  readonly point: Vec3Tuple | null;
}

/**
 * 結構型別替代 HTMLCanvasElement：shared 也會被 main（無 DOM lib）編譯，
 * renderer 傳入真正的 HTMLCanvasElement 時自動相容。
 */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: 'webgl2', options?: Record<string, unknown>): unknown;
}

export interface IAvatarRenderer {
  readonly kind: 'vrm' | 'live2d';

  /** 綁定 canvas、建立 WebGL context。只能呼叫一次。 */
  mount(canvas: CanvasLike, opts: { antialias: boolean; pixelRatio: number }): Promise<void>;

  /**
   * 載入模型。必須是「交易式」：
   * 新模型完整載入成功後才替換並 dispose 舊模型；失敗則 throw AppError('VRM_LOAD_FAILED') 且舊模型不受影響。
   */
  loadModel(url: string, signal?: AbortSignal): Promise<AvatarModelInfo>;

  /** 目前模型資訊；尚未載入時為 null。 */
  modelInfo(): AvatarModelInfo | null;

  /** 寫入指定層的表情權重（覆蓋該層的同名 key，未提及的 key 不變）。 */
  setExpressions(layer: ExpressionLayer, weights: ExpressionWeights): void;
  /** 清空指定層。 */
  clearExpressions(layer: ExpressionLayer): void;

  /** 寫入指定層的骨骼姿勢。Live2D 實作可為 no-op。 */
  setPose(layer: PoseLayer, pose: HumanoidPose): void;
  clearPose(layer: PoseLayer): void;

  setLookAt(target: LookAtTarget): void;

  /** NDC 座標（-1..1）命中測試；未命中回傳 null。 */
  hitTest(ndcX: number, ndcY: number): HitResult | null;
  /** 像素 alpha 命中測試（視窗 CSS 像素座標）；不支援時回傳 null 表示「請改用 hitTest」。 */
  alphaAt?(cssX: number, cssY: number): number | null;

  /** 角色頭部在畫面上的位置（CSS 像素），用於視線計算與氣泡定位。 */
  headScreenPosition(): { x: number; y: number } | null;

  resize(width: number, height: number, pixelRatio: number): void;
  update(dtSec: number): void;
  render(): void;
  /** 釋放所有 GPU 資源；之後此實例不可再用。 */
  dispose(): void;
}

/** 可替換的動作片段來源：程序化動畫或 VRMA 檔。 */
export interface ActionClip {
  readonly name: string;
  readonly durationSec: number;
  readonly loop: boolean;
  /** 進場/退場淡入淡出時間。 */
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
  /** 取樣：t 為 0..durationSec，回傳該時刻的加算姿勢與表情。 */
  sample(t: number): { pose: HumanoidPose; expressions?: ExpressionWeights; rootOffset?: Vec3Tuple };
}

export interface IActionClipSource {
  readonly id: string;
  has(name: string): boolean;
  get(name: string): ActionClip | null;
}
