# 依賴清單（2026-10-01 更新）

**選版原則**：預設使用最新穩定版；只有當最新版對本專案「沒有實質好處」或「會破壞相容性／風險高」時才保留舊版，並在下方說明原因。

所有版本皆為**精確版本**（無 `^`/`~`），並由 lockfile 鎖定：
- Node：`package-lock.json`（npm 11 產生；npm 10.9.x 解析此依賴樹會觸發 arborist bug，請用 npm ≥ 11）
- Python：`sidecar/uv.lock`（uv ≥ 0.12；`tool.uv.environments` 限定 win32 / linux）

## Node / Electron

| 套件 | 版本 | 是否最新穩定 | 用途 / 備註 |
|---|---|---|---|
| electron | 44.5.1 | ✅ | Node 24.21 / Chromium 152。44 起不在 postinstall 下載執行檔 → `npm run setup:electron`（`predev` 自動執行） |
| @pixiv/three-vrm | 3.5.5 | ✅ | VRM 0.x/1.0、表情、lookAt、SpringBone |
| @pixiv/three-vrm-animation | 3.5.5 | ✅ | 預留 VRMA |
| three / @types/three | 0.180.0 | ⏸ 最新 0.186.1 | 對齊 three-vrm 3.5.5 官方測試版本（見下） |
| zod | 4.6.5 | ✅ | |
| better-sqlite3 | 13.0.3 | ✅ | 13.x 為 N-API 預建檔，**不需對 Electron 重建** |
| koffi | 3.3.2 | ✅ | 全螢幕偵測 FFI；3.x 以平台子套件發佈（electron-builder 打包時需保留 `@koromix/koffi-win32-x64`） |
| electron-log | 5.4.4 | ✅ | |
| preact | 10.29.8 | ⏸ 最新 11.0.0 | 見下 |
| uiohook-napi（optional） | 1.5.5 | ✅ | hold-to-talk；N-API + win32-x64 預建檔【需驗證】 |
| electron-vite | 5.0.0 | ✅（6 為 beta） | 需手動設定 `build.target`：`node24` / `chrome152` |
| vite | 7.3.6 | ⏸ 最新 8.3.2 | electron-vite 5 peer 限 ≤7 |
| @preact/preset-vite | 2.10.6 | ✅ | |
| typescript | 6.0.3 | ⏸ 最新 7.0.2 | 見下 |
| typescript-eslint / eslint | 8.71.0 / 10.11.0 | ✅ | |
| vitest | 5.0.3 | ✅ | |
| electron-builder | 26.17.0 | ✅ | |
| @types/node | 24.19.0 | ✅（對齊 Node 24） | |
| @types/better-sqlite3 | 9.6.0 | ✅ | |
| ~~ws / @types/ws~~ | — | 移除 | Node 24 內建 `WebSocket` client |

## Python sidecar（Python 3.14）

| 套件 | 版本 | 是否最新穩定 | 備註 |
|---|---|---|---|
| Python | 3.14 | ✅ | 所有依賴皆有 cp314 或 abi3 的 win_amd64 wheel；已在 3.14.7 實測 TTS→STT 流程 |
| faster-whisper | 1.2.1 | ✅ | Silero VAD v6、`large-v3-turbo` 別名 |
| ctranslate2 | 4.8.2 | ✅ | CUDA 12 + cuDNN 9 |
| nvidia-cublas-cu12 / nvidia-cudnn-cu12（extra `cuda`） | 12.9.2.10 / 9.27.0.42 | ✅ | Windows 需 `os.add_dll_directory()`【需驗證】 |
| edge-tts | 7.2.8 | ✅ | 非官方 API，需連網 |
| nvidia-ml-py | 13.615.71 | ✅ | `import pynvml` |
| websockets | 17.1 | ✅ | |
| huggingface-hub | 1.33.0 | ⏸ 最新 2.0.0 | 見下 |
| numpy / onnxruntime / av / tokenizers | 2.5.3 / 1.30.0 / 19.0.0 / 0.23.2 | ✅ | 傳遞依賴 |
| pytest / pytest-asyncio / pyinstaller（dev） | 9.1.1 / 1.4.0 / 6.22.3 | ✅ | |

## 保留舊版的理由

| 套件 | 為什麼不用最新 |
|---|---|
| three 0.186 | three-vrm 3.5.5 的開發依賴與範例都鎖 r180；升到 r186 的 PR（#1878）尚未合併，且會丟棄舊版 MToonNodeMaterial 相容。對 WebGL 桌面角色，r180→r186 沒有可感知的效能或畫質差異，卻有表情/材質壞掉的風險 |
| vite 8 | electron-vite 5（最新穩定）不支援；要用 8 就得上 electron-vite 6 beta |
| typescript 7 | 編譯速度大幅提升，但 typescript-eslint 不支援（peer `<6.1`），TS 7 也移除了傳統 JS API。6.0.3 是可用工具鏈中最新的 |
| preact 11 | 發佈才一天，周邊套件尚未跟進；設定 UI 用不到 11 的新功能，升級無體感好處 |
| huggingface-hub 2.0 | 一週前發佈，breaking 是 HTTP 堆疊換成 httpx2；對「下載 Whisper 模型」沒有任何好處 |

## 外部執行環境（使用者安裝）

| 項目 | 需求 |
|---|---|
| Ollama | 支援 `format` JSON Schema 與 `think` 參數的版本【需驗證最低版本】 |
| NVIDIA 驅動 | CUDA 12.x 相容驅動；無 GPU 時走 CPU |
| 網路 | 僅 edge-tts 與首次下載 Whisper 模型需要 |

## 模型

| 模型 | 狀態 |
|---|---|
| `qwen3.8:27b`（預設值，可改） | ✅ 存在，約 18 GB |
| `qwen3:0.6b/1.7b/4b/8b/14b/30b/32b` | ✅ 低/中配推薦 |
| `bge-m3`（embedding 模式，選用） | ✅ |
| Whisper `tiny/base/small/medium/large-v3/large-v3-turbo` | ✅ |
