# 事件與 IPC 契約（第 1 階段）

## 檔案

| 檔案 | 內容 |
|---|---|
| `src/shared/types/domain.ts` | 情緒、動作、viseme、VRM preset（含 0.x→1.0 對照）、角色狀態、互動、品牌型別 `TurnId`/`UtteranceId` |
| `src/shared/types/errors.ts` | 31 個錯誤碼（對應降級矩陣）、`AppErrorInfo`（可跨 IPC）、`AppError`、`Result` |
| `src/shared/ai/AIResponse.ts` | AIResponse zod schema 工廠（動態 outfit enum）、Ollama `format` JSON Schema、永不 throw 的 `parseAIResponse` |
| `src/shared/providers/*.ts` | `STTProvider` / `TTSProvider` / `LLMProvider` / `GpuInfoProvider` / `MemoryStore` / `IAvatarRenderer` / `IActionClipSource` |
| `src/shared/events/EventMap.ts` | `SharedEvents`（可跨 IPC）/ `MainEvents` / `RendererEvents`，編譯期保證三者不重名 |
| `src/shared/events/TypedEventBus.ts` | 型別化事件匯流排 |
| `src/shared/events/IpcBridge.ts` | Bus ↔ IPC 橋接（與傳輸層無關） |
| `src/shared/ipc/channels.ts` | IPC 白名單：invoke / send / push，每個 channel 有 zod schema 與視窗權限 |
| `src/shared/config/merge.ts` | 設定深度合併、diff、寬鬆載入（壞區塊回退預設） |

## TypedEventBus 語意

| 行為 | 說明 |
|---|---|
| 同步派送 | `emit` 回傳前所有 handler 已執行（口型/動畫不能等 microtask） |
| 錯誤隔離 | handler throw 或 async reject → `onError`，不影響其他 handler、`emit` 不 throw |
| 快照迭代 | emit 期間新增的 listener 本次不執行；被移除且尚未執行的 listener 會跳過 |
| `once` | 即使 handler 內再次 emit 同事件也只執行一次 |
| void 事件 | `emit('ptt:down')`，不需 payload；型別系統強制 |
| `onAny` | 在具名 handler 之後執行，用於橋接/log |
| `waitFor` | 支援 `timeoutMs`、`AbortSignal`、`filter`，結束後自動解除訂閱 |
| 洩漏偵測 | 單一事件 listener 超過 `maxListeners`（預設 50）警告一次 |
| `dispose` | 之後 emit 為 no-op、訂閱會 throw |

## 跨程序資料流

```
main bus ──bridgeBusToTransport(role)──► webContents.send('companion:push:<ch>')
                                               │（只送 PUSH_CHANNELS 中允許該 role 的事件）
renderer preload (window.companion.on) ──bridgeTransportToBus──► renderer bus

renderer ──window.companion.invoke/send──► preload（白名單檢查）──► ipcMain（zod 驗證 + sender role 檢查）
```

- 只送事件不送函式；`Uint8Array` / `Float32Array` 經 structured clone 複製（已測試）。
- `MainEvents`（例如 `stt:audioChunk`）與 `RendererEvents`（例如 `render:frame`）型別上無法被橋接。

## 模組邊界（ESLint 強制）

| 位置 | 禁止 import |
|---|---|
| `src/shared/**` | `electron`、`three`、`node:*`、main / renderer / preload |
| `src/renderer/**` | `electron`、`node:*`、main |
| `src/main/**`, `src/preload/**` | renderer |
