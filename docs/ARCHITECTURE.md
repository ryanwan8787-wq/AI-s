# Desktop Companion — 架構說明（第 0 階段）

> 目標平台：Windows 11 x64。本文件是之後各階段的契約；若實作需偏離，先改本文件。
> 標示 **【需驗證】** 的項目代表我無法在此環境（Linux sandbox、無 GPU、無 Windows）實際驗證，會在對應階段以實測確認。

---

## 1. 程序模型

```
┌──────────────────────────── Electron (Windows 11) ─────────────────────────────┐
│                                                                                 │
│  ┌──────────────── main process (Node 24.21 / Electron 44) ─────────────────┐   │
│  │ AppLifecycle   單一實例鎖、系統匣、開機自啟、全域快捷鍵                    │   │
│  │ WindowManager  透明視窗、穿透切換、拖曳移動、DPI/多螢幕夾限、遮蔽偵測       │   │
│  │ CursorPoller   screen.getCursorScreenPoint() 30–60Hz → renderer            │   │
│  │ ConfigStore    zod 驗證、深度合併 patch、原子寫檔、廣播 config:changed     │   │
│  │ SidecarManager spawn / token / 健康檢查 / 指數退避重啟 / WS client          │   │
│  │ LlmService     Ollama client、模型切換、schema 測試、增量 JSON 解析        │   │
│  │ DialogueOrchestrator  STT結果→LLM→句子切分→TTS請求→事件                   │   │
│  │ MemoryService  better-sqlite3 + FTS5、摘要/抽取、top-k 注入、匯出          │   │
│  │ ResourceMonitor  GPU(經 sidecar) + Ollama /api/ps + 推薦預設 + 超量警告     │   │
│  │ MainEventBus   型別化事件匯流排（main 內部）                               │   │
│  └───────────────┬─────────────────────────────────────────────┬─────────────┘   │
│                  │ IPC（preload 白名單、zod 驗證 payload）        │ WebSocket     │
│  ┌───────────────▼──────────────── renderer (Chromium 152) ─┐   │ 127.0.0.1     │
│  │ AvatarStage   Three.js r180 + @pixiv/three-vrm 3.5        │   │ + token       │
│  │   IAvatarRenderer ← VrmRenderer | Live2DRenderer(stub)    │   │               │
│  │   AvatarController(狀態機) → Idle/Expression/Action/      │   │               │
│  │     EyeTracking/LipSync 各 Controller（分層合成）           │   │               │
│  │ InteractionController  pointer capture / hit test /       │   │               │
│  │     click·drag·long-press / 環形選單                       │   │               │
│  │ AudioEngine   麥克風擷取(AudioWorklet 16k PCM)、前端VAD、    │   │               │
│  │     TTS 播放佇列、AnalyserNode → LipSync                   │   │               │
│  │ SettingsApp   Preact 設定 UI（獨立視窗，同一 preload）       │   │               │
│  │ RendererEventBus                                          │   │               │
│  └───────────────────────────────────────────────────────────┘   │               │
└──────────────────────────────────────────────────────────────────┼───────────────┘
                                                                   │
                      ┌────────────────────────────────────────────▼─────────┐
                      │ Python sidecar (3.14, asyncio, websockets 17)        │
                      │  auth: 首訊息需帶啟動 token（由 main 產生，經 stdin 傳入）│
                      │  stt : faster-whisper 1.2.1（CUDA fp16 / CPU int8），   │
                      │        vad_filter=True（Silero v6），熱切換、下載進度   │
                      │  tts : edge-tts 7.2.8 → MP3 分塊串流回 main→renderer    │
                      │  gpu : nvidia-ml-py（import pynvml）總/已用 VRAM        │
                      └──────────────────────────────────────────────────────┘
                                   ▲
         Ollama (使用者自行安裝, http://127.0.0.1:11434) ◄── main LlmService (fetch)
```

### 為什麼這樣切

| 決策 | 理由 |
|---|---|
| LLM 呼叫放在 **main**，不放 renderer | CSP 可以把 renderer 的 `connect-src` 鎖成 `'self'`；記憶/DB 也在 main，避免把 prompt 組裝散在兩處；renderer 當機不影響對話狀態。 |
| sidecar 的 WebSocket **只由 main 連線**（Node 24 內建 `WebSocket` client，不需 `ws` 套件） | token 永遠不進 renderer；renderer 只看到型別化 IPC。音訊 PCM/MP3 以 `ArrayBuffer` 經 IPC 轉送（Electron IPC 支援結構化複製的 ArrayBuffer），每段 < 200KB，延遲可忽略。 |
| 麥克風在 **renderer** 擷取 | `getUserMedia` 只存在於 Chromium；Python 端不碰音訊裝置，避免 PortAudio 與權限問題。 |
| TTS 播放在 **renderer** | 口型需要同一個 `AudioContext` 的 `AnalyserNode`。 |
| sidecar token 以 **stdin** 傳入 | 不出現在命令列（工作管理員可看到 argv）也不寫檔。sidecar 綁 `127.0.0.1` + port 0，啟動後在 stdout 印一行 `READY {"port":N}`。 |

---

## 2. 資料流（一次對話）

```
[PTT 按下 / VAD 偵測語音開始]
  renderer AudioEngine ──(若 TTS 播放中 & bargeIn) → emit audio:bargeIn → 停止播放、清空佇列、取消 LLM 串流
  renderer: 16kHz mono Float32 分塊 ──IPC stt:audioChunk──► main ──WS stt.chunk──► sidecar(累積)
[PTT 放開 / VAD 靜音 ≥ minSilenceMs]
  main ──WS stt.end──► sidecar: model.transcribe(vad_filter=True, language, initial_prompt)
  sidecar ──stt.result {text, lang, durationMs}──► main → bus: stt:final
  main DialogueOrchestrator:
     1. MemoryService.buildContext(text, tokenBudget(numCtx))  → system prompt（人設 + few-shot + 記憶 + outfit 清單）
     2. LlmService.chatStream({format: AIResponseJSONSchema, stream:true, think?})
     3. IncrementalJsonParser 逐 token 餵入：
          ├─ emotion 完成 → bus: avatar:emotion  ──IPC──► renderer AvatarController   （表情先於語音）
          ├─ action  完成 → bus: avatar:action   ──IPC──► renderer
          ├─ outfitId 完成 → 白名單檢查 → avatar:outfit（非法則忽略）
          └─ reply 增量字元 → SentenceSplitter（。！？!?…\n 與最短字數）
                               → 每句 bus: tts:enqueue {seq, text}
     4. 串流結束 → zod 驗證整體；失敗 → 降級 {emotion:'idle', reply:原始文字}
     5. MemoryService.appendTurn()；每 M 輪 / 閒置 → 背景摘要
  main ──WS tts.speak {seq,text,voice}──► sidecar ──tts.audio(seq, mp3 chunks) / tts.done / tts.error──► main
  main ──IPC tts:audio──► renderer AudioEngine：依 seq 排序播放 → AnalyserNode → LipSyncController
     └─ TTS 失敗（斷網）→ bus: tts:failed → 僅顯示文字氣泡；本輪其餘句子直接走文字
  播放期間：echoStrategy=pause_capture → 不送 STT；barge-in 以能量門檻 + 連續 N 幀判定。
```

延遲目標（RTX 4070 級、qwen3:8b、whisper small）：放開 PTT → 第一個音節 < 1.8s（STT ~300ms、LLM 首句 ~700ms、edge-tts 首塊 ~500ms，後者受網路影響）。

---

## 3. 模組溝通規則

1. **模組之間不 import 彼此的實作**，只 import `src/shared/` 的型別與介面。
2. 同程序內：`TypedEventBus<EventMap>`（第 1 階段實作）。事件名稱採 `domain:verb`。
3. 跨程序：IPC channel 定義集中在 `src/shared/ipc/channels.ts`，每個 channel 有 zod schema；preload 只暴露白名單（`window.companion.invoke / on / send`），main 端 handler 一律先 `schema.parse`。
4. main ↔ sidecar：JSON-RPC 風格的 WS 訊息（`{id?, type, payload}`），schema 同樣以 zod（TS 端）與 dataclass/pydantic-free 手寫驗證（Py 端）描述，文件在 `docs/SIDECAR_PROTOCOL.md`（第 5 階段）。
5. 組裝點（composition root）只有兩個：`src/main/index.ts`、`src/renderer/src/main.ts`。只有它們能 `new` 具體實作並注入介面。

### Provider 介面（第 1 階段已定稿於 `src/shared/providers/*.ts`；以下為摘要）

```ts
interface STTProvider {
  readonly id: string;
  load(cfg: WhisperConfig, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<SttLoadResult>;
  beginUtterance(): UtteranceHandle;      // push(chunk: Float32Array) / end(): Promise<SttResult> / cancel()
  status(): SttStatus;
}
interface TTSProvider {
  readonly id: string;
  listVoices(locale?: string): Promise<VoiceInfo[]>;
  speak(req: { seq: number; text: string; voice: string; rate: string; pitch: string; volume: string },
        signal?: AbortSignal): AsyncIterable<Uint8Array>;   // MP3 chunks
}
interface LLMProvider {
  listModels(): Promise<LlmModelInfo[]>;                 // GET /api/tags
  runningModels(): Promise<LlmRunningModel[]>;           // GET /api/ps
  load(model: string): Promise<void>;                    // /api/chat messages:[]  → done_reason:"load"
  unload(model: string): Promise<void>;                  // keep_alive: 0
  chatStream(req: LlmChatRequest, signal?: AbortSignal): AsyncIterable<LlmChunk>;
}
interface IAvatarRenderer {
  readonly kind: 'vrm' | 'live2d';
  mount(canvas: HTMLCanvasElement): Promise<void>;
  loadModel(url: string): Promise<AvatarModelHandle>;    // 失敗時不得破壞目前模型
  setExpression(weights: Partial<Record<ExpressionKey, number>>, layer: ExpressionLayer): void;
  setBonePose?(pose: HumanoidPose, layer: PoseLayer): void;   // live2d 無骨骼 → optional
  hitTest(ndcX: number, ndcY: number): HitResult | null;
  update(dt: number): void;
  render(): void;
  dispose(): void;
}
interface GpuInfoProvider { query(): Promise<GpuSnapshot | null>; }   // null = 無 NVIDIA / NVML 失敗
interface MemoryStore { /* append/search/list/update/delete/export */ }
```

---

## 4. 各子系統的關鍵設計決策

### 4.1 視窗
- `BrowserWindow({ transparent:true, frame:false, resizable:false, hasShadow:false, alwaysOnTop, skipTaskbar, backgroundColor:'#00000000', webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } })`。
- 置頂等級 `setAlwaysOnTop(true, 'screen-saver')` 會蓋過全螢幕遊戲，因此預設用 `'floating'`，偵測到全螢幕前景時主動降級。
- 穿透：預設 `setIgnoreMouseEvents(true, { forward: true })`。renderer 在 `mousemove`（forward 模式下仍會收到）做命中測試，命中 → IPC `window:setInteractive(true)` → main 呼叫 `setIgnoreMouseEvents(false)`；離開 → 反向。加 80ms 遲滯避免邊緣抖動。
  - **【需驗證】** 多螢幕 + 不同 DPI 時 `forward: true` 的 mousemove 座標在 Electron 44 是否正確（有已知 issue 回報在混合 DPI 下偏移）。拖曳期間暫停穿透切換，避免 pointer capture 被打斷。
- 拖曳：renderer `pointerdown → setPointerCapture`，移動量以 `screenX/screenY`（DIP）差值送 `window:dragMove {dx,dy}`；main 以 `getBounds()` + 差值、依 `screen.getDisplayMatching()` 的 `workArea` 夾限後 `setPosition`。拖曳時不走 `-webkit-app-region`。
- 遮蔽偵測：Electron 無「被全螢幕程式遮住」的 API。方案：main 用 **koffi**（FFI）呼叫 `SHQueryUserNotificationState`（回傳 `QUNS_BUSY` / `QUNS_RUNNING_D3D_FULL_SCREEN` / `QUNS_PRESENTATION_MODE` 代表前景全螢幕）每 2 秒輪詢；另輔以 `GetForegroundWindow` + `MonitorFromWindow` 比對 rect。koffi 3.x 為 N-API 且以平台子套件（`@koromix/koffi-win32-x64`）發佈，不需針對 Electron 重建；**【需驗證】** Windows 實機呼叫結果。koffi 載入失敗時降級：只在 `blur` + 最小化時降 FPS。

### 4.2 角色控制與動畫分層
合成順序（每幀）：

```
1. IdleController      基礎姿勢（程序化呼吸：spine/chest 小幅 rotation；微擺動：hips 低頻 noise）
2. ActionController    一次性動作（nod / head_pat_react / wave / stretch / leave / return），
                       以權重 crossfade 疊加到 1 的結果上；可由 VRMA clip 取代（AnimationMixer）
3. EyeTrackingController  neck/head 骨骼加算旋轉 + vrm.lookAt 目標（眼睛）；動作層可暫時降低權重
4. ExpressionController   情緒表情（happy / relaxed / angry / surprised / sad 等，情緒→表情映射表），
                          眨眼（blink）由 Idle 產生但寫入此層；表情為「嘴形」時自動降低嘴部權重
5. LipSyncController      只寫 aa / ih / ou / ee / oh 五個 key，最後套用
→ vrm.expressionManager.update() / vrm.update(dt)
```
- VRM 0.x / 1.0 名稱差異交給 three-vrm 3.x：`VRMExpressionLoaderPlugin` 會把 0.x 的 `a/i/u/e/o`、`joy/sorrow/fun` 對應到 1.0 preset（`aa/ih/ou/ee/oh`、`happy/sad/relaxed`）。我們只使用 1.0 preset 名稱，缺少的 key 在載入時記錄並略過。VRM 0.x 模型需 `VRMUtils.rotateVRM0(vrm)` 修正朝向。
- `AvatarController` 狀態機：`booting → idle ⇄ listening ⇄ thinking ⇄ speaking`；`idle → reacting → idle`；`any → leaving → away → returning → idle`；`away/leaving/returning` 期間 InteractionController 被鎖定；`modelSwitching` 期間顯示思考待機並拒絕新對話。
- 動作資源：全部程序化；`IActionClipSource` 介面可替換為 `.vrma`（`@pixiv/three-vrm-animation` 的 `VRMAnimationLoaderPlugin` + `createVRMAnimationClip`，已確認 3.3.7 有匯出）。**不附任何 VRM/VRMA 檔**，首次啟動引導使用者選擇自己的 VRM。

### 4.3 視線
main 以 `setInterval(1000/pollHz)` 讀 `screen.getCursorScreenPoint()`，只在座標變化時送 `cursor:position`。renderer 將螢幕座標轉成視窗相對座標 → 以角色頭部世界座標為原點算 yaw/pitch → clamp（35°/20°）→ `MathUtils.damp` → 依權重分配（eyes 1.0 走 lookAt、neck 0.35、head 0.45）。游標長時間不動 > 8s，視線緩慢回正並隨機掃視。

### 4.4 互動判定
狀態機 `idle → pressed → (dragging | longPressed | released)`：移動 > 5px（DIP）→ drag；< 300ms 且未移動 → click；≥ 600ms 且未移動 → long press → 環形選單（換裝／設定／靜音／請角色離開）。頭部 sphere collider 掛在 `head` 骨骼下（半徑依頭骨到 neck 距離自動估算），命中 → `head_pat_react`，身體其他部位 → 輕微反應。拖曳時渲染迴圈照常（視窗移動與 WebGL 渲染無關；需確保 main 的 `setPosition` 不同步阻塞，採 rAF 節流合併移動量）。

### 4.5 口型
`AnalyserNode(fftSize=1024)` → 取 `getFloatFrequencyData`，將 80Hz–8kHz 分成低/中低/中/中高/高頻段，以能量比例啟發式映射到 `aa/oh/ou/ee/ih`；噪音閘、attack 40ms / release 100ms 的一階包絡。**這是近似方案，不是音素對齊**；降級模式 `volume` 只用 RMS 驅動 `aa`。播放結束 → 全部權重在 release 時間內收斂到 0。

### 4.6 語音
- 擷取：`getUserMedia({ audio:{ echoCancellation, noiseSuppression:true, autoGainControl:true, channelCount:1 } })` → AudioWorklet 重採樣至 16kHz Float32 → 每 100ms 一塊。
- push-to-talk：Electron `globalShortcut` 只有按下事件，**沒有 keyup** → 使用 `uiohook-napi`（optional dependency）取得真正的 hold-to-talk；載入失敗時退化成「按一下開始、再按一下結束」並在 UI 說明。uiohook-napi 1.5.5 為 N-API 並附 `win32-x64` 預建檔，理論上不需重建；**【需驗證】** Electron 44 實機載入。
- 持續監聽：前端以 RMS + 簡易頻譜平坦度做端點偵測（低延遲），再交由 faster-whisper `vad_filter=True`（Silero VAD v6，1.2.1 內建）過濾非語音段。
- 防回授：預設 `pause_capture`；barge-in 以「麥克風 RMS 高於 TTS 播放時的估計回授量 + 12dB 並持續 200ms」判定。
- TTS：edge-tts 需連網、且是非官方 API（Microsoft 可能變更端點/token 驗證），**失敗時一律降級為文字氣泡**，並在設定頁顯示最近一次錯誤。

### 4.7 模型選擇與資源管理
- LLM 切換流程：
  ```
  set state=modelSwitching（角色思考待機）
  → unload(old)            POST /api/chat {model:old, messages:[], keep_alive:0}
  → load(new)              POST /api/chat {model:new, messages:[]}     # done_reason:"load"
  → schemaProbe(new)       /api/chat format=AIResponse schema, stream:false, 最小 prompt
  → 驗證 OK: lastGoodModel=new；失敗: 提示 + unload(new) + load(lastGoodModel)
  ```
- `think` 參數：Ollama 目前文件允許 `boolean` 或 `"low"|"medium"|"high"|"max"`。我們只送 `false`（依 `modelProfiles[m].sendThinkFalse`）。**【需驗證】** 對非 thinking 模型送 `think:false` 在目前 Ollama 版本是否回 400（舊版會回 `"... does not support thinking"`）；若是，schemaProbe 會捕捉並自動把該 profile 的 `sendThinkFalse` 設為 false 後重試一次。
- Whisper 熱切換：sidecar 在背景執行緒建立新 `WhisperModel`，成功後原子替換並釋放舊模型（`del` + `gc.collect()`；CTranslate2 會釋放 CUDA 記憶體 **【需驗證】** 釋放是否即時）；失敗保留舊模型並回報。CUDA 初始化失敗（缺 cuDNN、驅動太舊、無 GPU）→ 自動改 `cpu/int8` 並送 `stt.fallback` 事件。
- 下載進度：faster-whisper 的 `download_model()` 內部把 `tqdm_class` 固定為 `disabled_tqdm`，**無法從外部傳入進度 callback**。方案：sidecar 自己呼叫 `huggingface_hub.snapshot_download(repo_id, allow_patterns=[...同 faster-whisper...], tqdm_class=ProgressTqdm)`，完成後把本機路徑交給 `WhisperModel(path, ...)`。repo 對照表取自 faster-whisper 1.2.1 `utils._MODELS`（已確認 `large-v3-turbo → mobiuslabsgmbh/faster-whisper-large-v3-turbo`）。取消：在 tqdm 子類別 `update()` 中檢查取消旗標並拋出例外，並清理 `.incomplete` 檔 **【需驗證】** huggingface-hub 1.x 的 `tqdm_class` 參數行為（1.x 已改用 `hf_xet` 下載後端，進度回報粒度可能不同）。
- GPU：`pynvml.nvmlInit → nvmlDeviceGetMemoryInfo`（總/已用/可用）、`nvmlDeviceGetName`、驅動版本；Ollama 佔用取 `/api/ps` 的 `size_vram`。
- 推薦預設（**估計值**，含 KV cache 與框架開銷的粗估，UI 會標示「估計」）：

  | 偵測 VRAM | 預設 | LLM 建議 | Whisper 建議 | 估計總佔用 |
  |---|---|---|---|---|
  | 無 NVIDIA / < 6 GB | 低配 | `qwen3:4b`（或 CPU 跑 `qwen3:1.7b`） | `base` / cpu / int8 | ≈ 3–4 GB |
  | 6–12 GB | 中配 | `qwen3:8b` | `small` / cuda / int8_float16 | ≈ 7–8 GB |
  | ≥ 16 GB（建議 24 GB） | 高配 | `qwen3:14b`（24 GB 可選 `qwen3.8:27b`） | `large-v3-turbo` / cuda / float16 | ≈ 12–22 GB |

  估算公式：`LLM ≈ 已安裝模型 size（/api/tags 的 size bytes） × 1.1 + KV(num_ctx)`，KV 以每 1k token 約 0.1–0.2 GB 粗估（依模型層數而異，為保守估計）；Whisper：tiny 0.4 / base 0.5 / small 1.0 / medium 2.0 / large-v3 3.5 / large-v3-turbo 2.0 GB（fp16；int8 約 60%）。超過 `總 VRAM × 0.9` 顯示警告但不阻擋。
- 模型名稱查核（2026-09-30 於 ollama.com 查詢）：`qwen3.8:27b` **存在**（約 18 GB，q4_K_M）；`qwen3:0.6b/1.7b/4b/8b/14b/30b/32b` 存在。`qwen3.8` 只有 27b 一個尺寸，因此低/中配推薦使用 `qwen3` 系列。預設值 `qwen3.8:27b` 需要約 20 GB 以上 VRAM，一般使用者多半會走「首次啟動引導選擇」流程——這是符合需求的預期行為。

### 4.8 LLM 結構化輸出
- JSON Schema 由 zod 定義後以 `z.toJSONSchema()` 產生（zod 4 內建），**`properties` 順序 = emotion → action → outfitId → reply**。Ollama 的 structured output 以 grammar 約束 token 產生，實務上會照 `properties` 順序輸出 **【需驗證】**：不同 Ollama 版本/模型是否總是遵守順序；增量解析器不依賴順序（任一欄位完成就發事件），只是順序正確時延遲最低。
- `outfitId` 的 `enum` 在每次請求時動態注入（可用清單為空時從 schema 移除該欄位）；解析後仍以白名單二次檢查。
- 增量 JSON 解析器：自寫的小型狀態機（只追蹤頂層物件的字串/列舉欄位與跳脫序列、`\uXXXX`），單元測試覆蓋被切在任意位元組邊界的輸入。

### 4.9 記憶
- SQLite（better-sqlite3，WAL）：`turns`（短期原文）、`memories`（type: fact / preference / event，content、importance 1–5、created_at、last_used_at、source_turn_ids）、`memories_fts`（FTS5，`tokenize='trigram'` 以支援中文子字串比對；SQLite ≥ 3.34 支援，better-sqlite3 12.x 內建版本足夠）。
- 相關度 = `bm25` 正規化 × 0.6 + 重要度 × 0.25 + 時間衰減 × 0.15；可切換 embedding 模式（Ollama `/api/embed` + 本機餘弦，向量存 BLOB）。
- token 預算：`budget = min(maxInjectTokens, numCtx × memoryCtxRatio)`；中文 token 粗估 1 字 ≈ 1 token（保守）。
- 敏感資料過濾：寫入前以正則攔截卡號（Luhn 驗證）、身分證字號、密碼/驗證碼關鍵字附近的字串、email/電話（可選），命中則不存或遮罩；摘要 prompt 也明確要求不抽取此類資訊。

### 4.10 長期運行
- 渲染器：`renderer.setAnimationLoop` 取代自管 rAF，依狀態切換目標 FPS（active 60 / idle 30 / occluded ≤10 或 0=暫停）；切換 VRM 時 `VRMUtils.deepDispose(scene)` + 紋理/材質/幾何全部 dispose，並監看 `renderer.info.memory`。
- sidecar：崩潰 → 退避 `min(base × 2^n, max)` + 抖動重啟；穩定運作 60s 後重置計數；超過 `maxRestarts` 停止並提示。
- 日誌：electron-log（`maxSize` 輪替）；sidecar 用 `logging.handlers.RotatingFileHandler`；每 5 分鐘記錄 `process.memoryUsage()`、`app.getAppMetrics()`、sidecar RSS。

### 4.11 安全
- `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`；禁止 `window.open`/導航（`setWindowOpenHandler` deny、`will-navigate` 阻擋）。
- CSP（production）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`。VRM 檔以自訂協定 `companion-asset://` 由 main 讀檔提供（只允許使用者選過的路徑），不開放 `file://`。
- IPC：preload 暴露 `invoke(channel, payload)` / `on(channel, cb)`，channel 必須在白名單常數內；main 端 `ipcMain.handle` 驗證 `event.senderFrame.url` 屬於本 app。
- sidecar：只綁 `127.0.0.1`；WS 第一則訊息必須是 `{type:"auth", token}`（32 bytes 隨機、`crypto.timingSafeEqual` / `hmac.compare_digest` 比對），否則 1s 內斷線；同一時間只允許一條連線。

### 4.12 降級矩陣

| 情況 | 偵測 | 降級行為 | 使用者提示 |
|---|---|---|---|
| Ollama 未啟動 | `/api/tags` 連線拒絕 | 角色可互動、不能對話；每 10s 重試 | 氣泡 + 設定頁紅燈「Ollama 未啟動」與官網連結 |
| 模型不存在 | `/api/tags` 無此 tag / chat 回 404 | 引導從已安裝清單選擇 | 對話框 |
| 模型載入失敗 / VRAM 不足 | load 回錯誤或 timeout；`/api/ps` size_vram < size（部分 offload 到 CPU） | 退回 lastGoodModel；部分 offload 時提示變慢 | 通知 + 設定頁警告 |
| sidecar 崩潰 | 程序 exit / WS close / 心跳逾時 | 自動重啟（退避）；期間停用語音、保留文字輸入 | 系統匣圖示變色 + 氣泡 |
| 麥克風權限被拒 | `getUserMedia` NotAllowedError | 切換為文字輸入模式 | 說明如何在 Windows 隱私設定開啟 |
| TTS 斷網 | edge-tts 例外 / 逾時 3s | 本輪改文字氣泡；背景每 60s 探測 | 小圖示「語音離線」 |
| Whisper 下載失敗 | snapshot_download 例外 | 保留舊模型；可重試 | 設定頁錯誤訊息 + 重試按鈕 |
| CUDA 不可用 | CTranslate2 例外 / `get_cuda_device_count()==0` | cpu + int8 | 設定頁黃燈 |
| VRM 載入失敗 | GLTFLoader 例外 / 無 `userData.vrm` | 保留原角色 | 氣泡 + 錯誤細節 |
| LLM 輸出壞掉 | zod 驗證失敗 | `{emotion:'idle', reply:原文}` | 無（記 log） |

---

## 5. 專案樹（完整規劃；第 0 階段只建立 ★ 檔案）

```
desktop-companion/
├─ package.json ★                 # 精確版本（無 ^）
├─ package-lock.json ★            # npm lockfile
├─ tsconfig.json ★  tsconfig.base.json ★  tsconfig.node.json ★  tsconfig.web.json ★
├─ electron.vite.config.ts        # [2]
├─ electron-builder.yml           # [8]
├─ vitest.config.ts               # [1]
├─ eslint.config.js               # [1]
├─ .gitignore ★
├─ README.md ★
├─ docs/
│  ├─ ARCHITECTURE.md ★           # 本文件
│  ├─ DEPENDENCIES.md ★           # 依賴清單與版本查核
│  ├─ CONFIG.md ★                 # 設定 schema 說明
│  ├─ SIDECAR_PROTOCOL.md         # [5]
│  ├─ LIPSYNC.md                  # [6] 近似方案說明
│  └─ PERSONA.md                  # [7] 人設與 few-shot
├─ resources/
│  ├─ icons/ (tray.ico, app.ico)  # [2] 自製圖示
│  └─ README.md                   # 說明：不內建任何 VRM / VRMA
├─ src/
│  ├─ shared/                     # 純型別與純函式，main/renderer 皆可 import
│  │  ├─ config/schema.ts ★       # zod 設定 schema
│  │  ├─ config/merge.ts ✅        # [1] deepMerge / diff / lenient load
│  │  ├─ events/EventMap.ts       # [1] 所有事件的 payload 型別
│  │  ├─ events/TypedEventBus.ts  # [1]
│  │  ├─ ipc/channels.ts          # [1] IPC 白名單 + zod payload
│  │  ├─ providers/{stt,tts,llm,avatar,gpu,memory}.ts   # [1] Provider 介面
│  │  ├─ ai/AIResponse.ts         # [1] zod schema + JSON Schema 產生
│  │  ├─ ai/IncrementalJsonParser.ts   # [7]
│  │  ├─ ai/SentenceSplitter.ts   # [7]
│  │  └─ hardware/presets.ts      # [8] VRAM 估算與推薦
│  ├─ main/
│  │  ├─ index.ts                 # [2] composition root
│  │  ├─ app/{singleInstance,tray,autoLaunch,hotkeys,pushToTalk}.ts   # [2]
│  │  ├─ window/{WindowManager,DragController,CursorPoller,OcclusionMonitor,displayUtils}.ts  # [2]
│  │  ├─ config/ConfigStore.ts    # [2]
│  │  ├─ ipc/registerHandlers.ts  # [2]
│  │  ├─ protocol/assetProtocol.ts   # [3] companion-asset://
│  │  ├─ sidecar/{SidecarManager,SidecarClient,backoff}.ts   # [5]
│  │  ├─ providers/{SidecarSTTProvider,SidecarTTSProvider,SidecarGpuProvider}.ts  # [5]
│  │  ├─ llm/{OllamaProvider,ModelSwitcher,SchemaProbe,PromptBuilder}.ts   # [7]
│  │  ├─ dialogue/DialogueOrchestrator.ts   # [7]
│  │  ├─ memory/{MemoryService,SqliteMemoryStore,Summarizer,SensitiveFilter,migrations}.ts  # [7]
│  │  ├─ resources/ResourceMonitor.ts   # [8]
│  │  └─ logging/logger.ts        # [2]
│  ├─ preload/
│  │  ├─ index.ts                 # [2] contextBridge 白名單
│  │  └─ index.d.ts               # [2] window.companion 型別
│  └─ renderer/
│     ├─ index.html               # [2] 角色視窗
│     ├─ settings.html            # [8] 設定視窗
│     └─ src/
│        ├─ main.ts               # [3] composition root（角色）
│        ├─ bridge/ipcClient.ts   # [2]
│        ├─ avatar/
│        │  ├─ IAvatarRenderer.ts → re-export shared
│        │  ├─ vrm/{VrmRenderer,VrmLoader,expressionMap,boneUtils}.ts   # [3]
│        │  ├─ live2d/Live2DRenderer.ts   # [8] stub
│        │  ├─ AvatarController.ts        # [3] 狀態機
│        │  ├─ controllers/{Idle,Expression,EyeTracking,LipSync,Action}Controller.ts  # [3][4][6]
│        │  ├─ actions/{procedural/*.ts, VrmaClipSource.ts, IActionClipSource.ts}     # [4]
│        │  └─ RenderLoop.ts              # [3] FPS 策略
│        ├─ interaction/{InteractionController,HitTester,RadialMenu}.ts   # [4]
│        ├─ audio/{AudioEngine,MicCapture,capture.worklet.ts,FrontendVad,TtsPlayer,SpectralLipSync}.ts  # [5][6]
│        ├─ ui/{SpeechBubble,Toast}.tsx   # [4]
│        └─ settings/                     # [8] Preact 設定 UI
│           ├─ SettingsApp.tsx
│           └─ pages/{General,Model,Voice,Avatar,Persona,Memory,Hotkeys,Performance}.tsx
├─ sidecar/
│  ├─ pyproject.toml ★            # 依賴宣告（精確版本）
│  ├─ uv.lock ★                   # uv lockfile
│  ├─ companion_sidecar/
│  │  ├─ __init__.py ★
│  │  ├─ __main__.py              # [5] 入口：讀 stdin token、綁 127.0.0.1:0、印 READY
│  │  ├─ server.py                # [5] WS 路由、auth、心跳
│  │  ├─ protocol.py              # [5] 訊息型別
│  │  ├─ stt/{engine,downloader,cuda_probe}.py   # [5]
│  │  ├─ tts/edge.py              # [5]
│  │  ├─ gpu/nvml.py              # [5]
│  │  └─ logging_setup.py         # [5]
│  ├─ tests/                      # [5] pytest
│  └─ companion_sidecar.spec      # [8] PyInstaller
└─ tests/                         # [1]+ vitest（shared / main 純邏輯）
```

---

## 6. 驗證狀態總表（2026-10-01 更新：全面改用最新穩定版，例外見「保留舊版」）

| 項目 | 狀態 |
|---|---|
| electron **44.5.1**（Node 24.21 / Chromium 152，2026-09-29） | ✅ 最新穩定版、受安全更新支援。34→44 的 breaking changes 已逐條比對，對本專案有影響的只有：①`electron` 不再於 postinstall 下載執行檔 → `predev` 呼叫 `install-electron`；②renderer 不能用 `clipboard` 模組（本專案不使用，若需要改走 IPC）；③移除 Windows 32-bit（本專案只出 x64） |
| three **0.180.0** / @types/three 0.180.0 | ✅ 非最新 0.186（見保留舊版） |
| @pixiv/three-vrm **3.5.5**、three-vrm-animation 3.5.5 | ✅ 最新穩定版（含 VRM0 humanoid / SpringBone / MToon 錯誤處理修正）。`VRMUtils.deepDispose/rotateVRM0/combineSkeletons`、`createVRMAnimationClip` 存在 |
| electron-vite 5.0.0 | ✅ 最新穩定（6.0 仍為 beta）。其內建 Electron→target 對照表只到 39 → **需在 `electron.vite.config.ts` 明確設定 `build.target`（main/preload: `node24`，renderer: `chrome152`）**，否則會退化成 node22/chrome142 |
| vite 7.3.6 | 非最新 8.x（electron-vite 5 peer 限 ≤7） |
| zod 4.6.5 | ✅ 最新 |
| better-sqlite3 **13.0.3** | ✅ 最新。13.x 改為 **N-API 預建檔（含 win32-x64）**，不再需要對 Electron ABI 重建；已實測 FTS5 `trigram` 中文子字串檢索（SQLite 3.53.4） |
| koffi **3.3.2** | ✅ 最新。3.x 指標改為 BigInt；我們只呼叫回傳整數的 `SHQueryUserNotificationState`/`GetForegroundWindow`，無影響 |
| ws | ❌ 移除：Node 24 內建穩定的 `WebSocket` client |
| faster-whisper 1.2.1 / ctranslate2 4.8.2 / edge-tts 7.2.8 | ✅ 最新；Python **3.14** 上已實測 edge-tts 合成 → PyAV 解碼 → whisper tiny CPU int8 + VAD 辨識成功 |
| Python **3.14**（sidecar） | ✅ 最新穩定；所有依賴都有 cp314 / abi3 的 win_amd64 wheel |
| nvidia-ml-py 13.615.71（`import pynvml`） | ✅ |
| Ollama API（/api/tags, /api/ps, /api/chat format/think/keep_alive） | ✅ 對照官方 docs/api.md |
| `qwen3.8:27b` | ✅ ollama.com 存在（約 18 GB） |
| uiohook-napi 1.5.5（hold-to-talk） | 【需驗證】Electron 44 實機 |
| koffi 全螢幕偵測 | 【需驗證】Windows 實機 |
| `forward:true` 混合 DPI 座標 | 【需驗證】 |
| huggingface-hub 1.x `tqdm_class` 進度攔截 | 【需驗證】第 5 階段 |
| Ollama structured output 欄位順序 | 【需驗證】第 7 階段 |

### 保留舊版（最新版對本專案「沒有更好」或「有風險」）

| 套件 | 採用 | 最新 | 原因 |
|---|---|---|---|
| three | 0.180.0 | 0.186.1 | three-vrm 3.5.5 官方對齊並測試 r180；r186 支援仍是未合併的 PR #1878（且含 MToonNodeMaterial breaking）。WebGL 路徑上 r180→r186 對本專案沒有體感差異 |
| vite | 7.3.6 | 8.3.2 | electron-vite 5 只接受 ≤7；8 需改用 electron-vite 6 beta |
| typescript | 6.0.3 | 7.0.2 | TS 7（Go 版）編譯快很多，但 typescript-eslint 8.71 peer 限 `<6.1`、且 TS 7 不再提供傳統 JS API（只有 `unstable/*`），lint 工具鏈會壞。6.0 是相容系列最新版 |
| preact | 10.29.8 | 11.0.0 | 11.0.0 於 2026-09-30（前一天）才發佈，生態（@preact/preset-vite 2.10.6 等）尚未跟上；設定 UI 不需要 11 的新功能。待 11.0.x 穩定後再升 |
| huggingface-hub | 1.33.0 | 2.0.0 | 2.0.0 於 2026-09-24 發佈，主要變更是 HTTP 堆疊改為 httpx2（breaking）；對下載 Whisper 模型沒有收益 |
| electron-vite | 5.0.0 | 6.0.0-beta.5 | 6 仍為 beta |
