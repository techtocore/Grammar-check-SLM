# Grammar Check SLM 🔍✍️

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![AI: 100% on-device](https://img.shields.io/badge/AI-100%25%20on--device-10B981)
![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen)

A privacy-first Chromium extension that fixes grammar and spelling **entirely on your device**. It
uses a downloaded **Qwen** model via
[Transformers.js](https://github.com/huggingface/transformers.js) by default. Chrome's **built-in AI
(Gemini Nano)** is available as an optional engine. Edited text is never uploaded; local model
weights download once during setup and are then cached for offline use.

![Extension pop-up and suggested corrections](/assets/extension.png)

## ✨ Features

- 🔒 **Truly private corrections** — every check runs locally; edited text is never uploaded.
- 🤖 **Reliable local default** — **Qwen3.5 0.8B** on WebGPU, with **Qwen3 0.6B** selected for WASM
  and memory-constrained devices.
- ⚡ **Optional Chrome AI** — Automatic uses **Gemini Nano** only when it is already ready, without
  interrupting checks to download it.
- ✒️ **Real-world fields** — rich-text (`contenteditable`) **and** `<textarea>` / `<input>`.
- 🎯 **Precise fixes** — a word-level **LCS diff** maps each correction to an exact text range, and
  **sentence-aware** checking (`Intl.Segmenter`) with caching never re-processes unchanged text.
- 🎨 **No caret jumps** — non-destructive **CSS Custom Highlight API** for rich text, a positioned
  overlay for inputs.
- ✍️ **Built-in editor** — paste a sentence or paragraph for an instant diff view, automatic local
  draft recovery, a full-page editing mode, and one-click **copy**.
- 🖱️ **Right-click to correct** — select text anywhere to fix it in place, or copy the corrected
  version for read-only text.
- 🛠️ **Configurable** — engine, model, acceleration, typing delay, fields, and per-site rules.

## 🏗️ How it works

```
Content script  ──check──▶  Service worker  ──config──▶  Offscreen document
  field adapters             message router              Prompt API (Gemini Nano)
  highlighter                settings + menus            Transformers.js (Qwen3.5 / Qwen3)
  tooltip                    offscreen lifecycle         WebGPU / WASM · LRU cache
       ◀─────────────────  corrections  ───────────────────────
```

- **`src/core`** — pure, fully unit-tested logic: tokenizer, LCS word diff, sentence segmentation,
  LRU cache, prompt building, and correction assembly.
- **`src/offscreen`** — hosts the engines (Prompt API + Transformers.js), device selection, caching.
- **`src/background`** — message router, offscreen lifecycle, settings, context menus.
- **`src/content`** — field discovery, adapters (contenteditable / input), highlighter, tooltip.
- **`src/popup` · `src/options`** — the UI.
- **`src/shared`** — typed message protocol, settings storage, model catalogue, logger.

## 🚀 Getting started

### Prerequisites

- Node.js 20.19+
- A Chromium-based browser, version **116+** (for the offscreen + `getContexts` APIs). WebGPU
  (Chrome 113+) is used automatically when available.

### Build

```bash
npm ci
npm run build      # production build into ./build
# or: npm run dev   # watch mode
```

### Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `build` directory
4. Try it on any website, or open the included [`test.html`](/test.html)

> **Testing with `test.html` (a local file):** Chrome does **not** run extensions on `file://`
> pages by default. Either enable **“Allow access to file URLs”** on the extension's details page,
> or serve the file over HTTP (e.g. `npx serve .` then open `http://localhost:3000/test.html`).

On first installation, the extension opens Settings and immediately downloads the recommended local
model (about 1 GB with WebGPU or 550 MB with WASM), with visible progress and retry guidance. The
model stays on the device and is cached for offline use. Setup finishes only after a test sentence
is corrected successfully, then activates grammar checking in already-open browser tabs. Chrome
built-in AI can also be set up from Settings when supported. Wavy underlines appear once the local
engine is ready. Open the page's DevTools console for `[GrammarSLM:content]` logs to confirm checks
are running.

## ⚙️ Configuration

Open the extension's **Settings** page (or the ⚙ button in the popup) to configure:

| Setting      | Description                                                             |
| ------------ | ----------------------------------------------------------------------- |
| AI engine    | `Local` (default), `Automatic` (any ready engine), or `Chrome AI` only  |
| Local model  | `Recommended for this device`, Qwen3.5 0.8B, or Qwen3 0.6B              |
| Acceleration | `Automatic` (WebGPU → WASM), WebGPU only, or WASM only (local models)   |
| Language     | BCP-47 locale used for sentence segmentation                            |
| Typing delay | Debounce before a check runs                                            |
| Fields       | Toggle rich-text and/or input/textarea checking                         |
| Sites        | Run everywhere, only on an allow list, or everywhere except a deny list |

Right-click the toolbar icon or any text field to quickly toggle checking on the current site.
Select text anywhere and right-click **“Correct grammar of …”** to correct it in place (or copy the
result for read-only text).

### Engines

- **Local models (Transformers.js)** — the default engine prepared and verified during first-run
  setup. `Recommended for this device` selects **Qwen3.5 0.8B** with WebGPU or **Qwen3 0.6B** with
  WASM. Qwen3.5 uses a verified mixed-precision configuration and requires WebGPU; Qwen3 0.6B is the
  compatible choice for older or memory-constrained devices.
- **Automatic engine** — uses Chrome built-in AI only when Gemini Nano is already ready, otherwise
  it immediately uses the selected local model. It never starts a Chrome AI download during a tab
  grammar check.
- **Chrome built-in AI (Prompt API / Gemini Nano)** — optional. Chrome manages and shares this model
  across the browser. Settings provides its explicit one-time **Set up** action when supported.

## 🧪 Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (flat config)
npm run test        # vitest (core + DOM mapping)
npm run format      # prettier
npm run check       # typecheck + lint + test + build
```

The core algorithms (diff, segmentation, caching, correction assembly) and the contenteditable
offset↔DOM mapping are covered by unit tests under `src/**/*.test.ts`.

## 🔧 Tech stack

- TypeScript · Webpack 5 · Chrome Extension Manifest V3 (offscreen document)
- Chrome built-in AI **Prompt API** (Gemini Nano) with a Transformers.js fallback
- Transformers.js (ONNX Runtime Web) with WebGPU + WASM · Qwen3.5 / Qwen3 SLMs
- `Intl.Segmenter` · CSS Custom Highlight API
- Vitest · ESLint · Prettier

## 🔒 Privacy

Your text is checked **entirely on your device** and is never sent to the
developer or any third party. The extension has no servers, no accounts, no
analytics, and no tracking. Settings, built-in editor drafts, and downloaded
model files are stored locally. See the full [Privacy Policy](PRIVACY.md).

## 🙏 Acknowledgments

- [Hugging Face](https://huggingface.co/) for Transformers.js and the ONNX model conversions
- [Qwen team](https://github.com/QwenLM/Qwen3) for the Qwen3 models
- AI coding tools including GitHub Copilot

## 📦 Publishing

- **License** — [MIT](LICENSE)
- **Privacy policy** — [PRIVACY.md](PRIVACY.md) (this is the URL to give the
  Chrome Web Store dashboard)
- **Release notes** — [CHANGELOG.md](CHANGELOG.md)

Build the extension with `npm run build`, then zip the **contents** of `build/`
(with `manifest.json` at the zip root) to upload.

## 📄 License

[MIT](LICENSE) © techtocore

---

**Made with ❤️ for privacy-conscious users**
