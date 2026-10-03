export interface VoiceInfo {
  /** 短名，例如 zh-TW-HsiaoChenNeural。 */
  readonly name: string;
  readonly locale: string;
  readonly gender: 'Female' | 'Male' | 'Unknown';
  readonly displayName?: string;
}

export interface TtsRequest {
  /** 同一輪對話內的句子序號，播放端依此排序。 */
  readonly seq: number;
  readonly text: string;
  readonly voice: string;
  /** Edge TTS 格式：'+0%'、'-10%'。 */
  readonly rate: string;
  /** '+0Hz'。 */
  readonly pitch: string;
  readonly volume: string;
}

/** 音訊容器格式。edge-tts 預設輸出 audio-24khz-48kbitrate-mono-mp3。 */
export type TtsAudioFormat = 'mp3';

export interface TtsChunk {
  readonly seq: number;
  readonly format: TtsAudioFormat;
  readonly data: Uint8Array;
}

/**
 * 文字轉語音提供者。實作：SidecarTTSProvider（edge-tts，第 5 階段）。
 * 規範：
 * - `speak()` 以 AsyncIterable 回傳音訊分塊，第一塊盡早送出（降低首音延遲）。
 * - signal abort → 迭代立即結束且不 throw（barge-in 時大量發生，不算錯誤）。
 * - 網路錯誤 throw AppError('TTS_NETWORK')，呼叫端降級為文字氣泡。
 */
export interface TTSProvider {
  readonly id: string;
  listVoices(localePrefix?: string): Promise<readonly VoiceInfo[]>;
  speak(req: TtsRequest, signal?: AbortSignal): AsyncIterable<TtsChunk>;
  /** 輕量健康檢查（例如合成一個極短字串），用於斷網後的背景探測。 */
  probe(signal?: AbortSignal): Promise<boolean>;
}
