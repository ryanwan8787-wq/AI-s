export interface GpuDevice {
  readonly index: number;
  readonly name: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  /** 0–100；NVML 不支援時為 null。 */
  readonly utilizationPct: number | null;
}

export interface GpuSnapshot {
  readonly vendor: 'nvidia';
  readonly driverVersion: string;
  readonly cudaDriverVersion: string | null;
  readonly devices: readonly GpuDevice[];
  readonly takenAt: string;
}

/**
 * GPU 資訊提供者。實作：SidecarGpuProvider（pynvml，第 5 階段）。
 * 回傳 null 代表沒有 NVIDIA GPU 或 NVML 初始化失敗 → UI 隱藏 CUDA 選項並使用 CPU 預設。
 */
export interface GpuInfoProvider {
  readonly id: string;
  query(): Promise<GpuSnapshot | null>;
}
