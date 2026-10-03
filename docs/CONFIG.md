# 設定（config.json）

- 位置：`%APPDATA%/Desktop Companion/config.json`（`app.getPath('userData')`）
- 定義：`src/shared/config/schema.ts`（zod 4），**所有欄位都有預設值**，`AppConfigSchema.parse({})` 即為完整預設設定。
- 寫入：只有 main 寫檔（先寫 `.tmp` 再 rename，原子替換）；renderer 送 `config:patch`（DeepPartial）→ main 深度合併 → 重新驗證 → 寫檔 → 廣播 `config:changed { next, changedPaths }`。
- 驗證失敗的檔案：備份為 `config.invalid-<時間>.json`，逐區塊回退為預設值並提示使用者。
- 熱更新：見 `CONFIG_HOT_RELOAD`。除了 `sidecar.*`（需重啟）外全部即時生效。

| 區塊 | 重點欄位 | 生效 |
|---|---|---|
| `llm` | `ollamaBaseUrl`（僅 loopback）、`model`（預設 `qwen3.8:27b`）、`lastGoodModel`、`modelProfiles[tag]`（temperature/topP/numCtx/numPredict/sendThinkFalse/lastSchemaCheck）、`keepAlive` | hot（切換流程：unload→load→schema probe→失敗回退） |
| `stt` | `mode`（push_to_talk / continuous_vad）、`vad.*`、`bargeIn`、`echoStrategy`、`whisper.{modelSize,device,computeType,language,beamSize,initialPrompt,downloadRoot,lastGood}` | whisper.* → sidecar 熱重載；其餘 hot |
| `tts` | `voice`（預設 `zh-TW-HsiaoChenNeural`）、rate/pitch/volume、outputGain、minSentenceChars | hot |
| `lipSync` | `mode`（spectral / volume 降級）、noiseGateDb、attackMs=40、releaseMs=100 | hot |
| `avatar` | `vrmPath`、`outfits[]`（id 供 LLM 使用）、`vrmaOverrides`、`eyeTracking`（pollHz 30–60、yaw 35°、pitch 20°、權重、damping） | hot（載入失敗保留原角色） |
| `persona` | name、userCallName、personality、speakingStyle、taboos、extra | hot |
| `memory` | shortTermTurns、summarizeEveryTurns、summarizeOnIdleMinutes、topK、maxInjectTokens、memoryCtxRatio、retrieval | hot |
| `proactive` | minIntervalMinutes、maxPerDay、doNotDisturb、quietHours、suppressWhenFullscreen | hot |
| `window` | 尺寸、位置/displayId、alwaysOnTop、skipTaskbar、hitTest | hot |
| `performance` | fpsActive/fpsIdle/fpsOccluded（0=暫停）、pixelRatioCap、antialias | hot |
| `hotkeys` | pushToTalk、toggleVisible、toggleMute、openSettings | hot |
| `sidecar` | port（0=自動）、pythonPath（開發用）、重啟退避參數 | restart |
| `system` | launchAtLogin、logLevel、日誌輪替、onboardingDone、hardwarePreset | hot |

## 範例（部分覆寫）

```json
{
  "llm": {
    "model": "qwen3:8b",
    "modelProfiles": {
      "qwen3:8b": { "temperature": 0.6, "numCtx": 8192, "sendThinkFalse": true },
      "gemma3:4b": { "numCtx": 4096, "sendThinkFalse": false }
    }
  },
  "stt": { "whisper": { "modelSize": "small", "device": "cuda", "computeType": "int8_float16" } },
  "tts": { "voice": "zh-CN-XiaoxiaoNeural" }
}
```
