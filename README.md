# Desktop Companion

Windows 11 的 3D 桌面 AI 虛擬伴侶：透明無邊框的 VRM 角色常駐桌面，支援語音對話、表情/動作、長期記憶，並依硬體推薦 LLM 與 Whisper 模型大小。

> 目前進度：**第 1 階段完成**（核心型別、Provider 介面、Event Bus、IPC 白名單、單元測試）

- 架構：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 依賴與版本查核：[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)
- 設定：[docs/CONFIG.md](docs/CONFIG.md)，schema 在 `src/shared/config/schema.ts`
- 事件與 IPC：[docs/EVENTS_AND_IPC.md](docs/EVENTS_AND_IPC.md)

## 需求
- Windows 11 x64、Node ≥ 22.12（建置用；執行時為 Electron 44 內建 Node 24）、npm ≥ 11
- Python 3.14 + [uv](https://docs.astral.sh/uv/)
- [Ollama](https://ollama.com)（本機 `http://127.0.0.1:11434`）
- 選用：NVIDIA GPU（CUDA 12 相容驅動）

## 開發
```bash
npm ci
npm run setup:electron          # Electron 44 起不在 postinstall 下載執行檔
cd sidecar && uv sync --frozen --extra cuda   # 無 NVIDIA 可省略 --extra cuda
```

本專案**不內建任何 VRM 模型或動畫**，請使用你擁有使用權的 VRM 檔。

## 測試
```bash
npm test              # vitest：單元測試 + 型別測試（*.test-d.ts）
npm run test:coverage
npm run lint          # 含模組邊界規則
npm run typecheck
```
