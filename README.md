# Grammar Check SLM 🔍✍️

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![AI: 100% on-device](https://img.shields.io/badge/AI-100%25%20on--device-10B981)
![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen)

A privacy-first Chromium extension that fixes grammar and spelling **entirely on your device**. It
uses Chrome's **built-in AI (Gemini Nano)** when available and falls back to a downloaded **Qwen3**
model via [Transformers.js](https://github.com/huggingface/transformers.js). Edited text is never
uploaded; local model weights download once on first use and are then cached for offline use.

![Extension pop-up and suggested corrections](/assets/extension.png)

## ✨ Features

- 🔒 **Truly private corrections** — every check runs locally; edited text is never uploaded.
- ⚡ **Chrome built-in AI first** — uses the **Prompt API (Gemini Nano)** when available. Chrome
  manages its one-time setup/download and shares the model across the browser.
- 🤖 **Local SLM fallback** — Alibaba's **Qwen3 0.6B** (default) or **1.7B** via Transformers.js,
  **WebGPU**-accelerated with a WASM fallback. FLAN-T5 is available for maximum compatibility.
- ✒️ **Real-world fields** — rich-text (`contenteditable`) **and** `<textarea>` / `<input>`.
- 🎯 **Precise fixes** — a word-level **LCS diff** maps each correction to an exact text range, and
  **sentence-aware** checking (`Intl.Segmenter`) with caching never re-processes unchanged text.
- 🎨 **No caret jumps** — non-destructive **CSS Custom Highlight API** for rich text, a positioned
  overlay for inputs.
- ✍️ **Built-in editor** — paste a sentence or paragraph into the popup for an instant diff view and
  one-click **copy**.
- 🖱️ **Right-click to correct** — select text anywhere to fix it in place, or copy the corrected
  version for read-only text.
- 🛠️ **Configurable** — engine, model, acceleration, typing delay, fields, and per-site rules.

## 🏗️ How it works

```
Content script  ──check──▶  Service worker  ──config──▶  Offscreen document
  field adapters             message router              Prompt API (Gemini Nano)
  highlighter                settings + menus            Transformers.js (Qwen3)
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

On first use, Chrome built-in AI is ready right away (set up Gemini Nano once from Settings if
prompted); a local model instead downloads from Hugging Face and is cached for offline use. The model
loads only when you request a correction or focus an eligible field; the extension does not start a
large download merely because it was installed or its popup was opened. Wavy underlines appear once
the engine is ready. Open the page's DevTools console for `[GrammarSLM:content]` logs to confirm checks
are running.

## ⚙️ Configuration

Open the extension's **Settings** page (or the ⚙ button in the popup) to configure:

| Setting      | Description                                                                  |
| ------------ | ---------------------------------------------------------------------------- |
| AI engine    | `Automatic` (Chrome AI, else local), `Chrome AI` only, or `Local` model only |
| Local model  | Fallback model: `Automatic`, Qwen3 0.6B / 1.7B, or FLAN-T5 Base              |
| Acceleration | `Automatic` (WebGPU → WASM), WebGPU only, or WASM only (local models)        |
| Language     | BCP-47 locale used for sentence segmentation                                 |
| Typing delay | Debounce before a check runs                                                 |
| Fields       | Toggle rich-text and/or input/textarea checking                              |
| Sites        | Run everywhere, only on an allow list, or everywhere except a deny list      |

Right-click the toolbar icon or any text field to quickly toggle checking on the current site.
Select text anywhere and right-click **“Correct grammar of …”** to correct it in place (or copy the
result for read-only text).

### Engines

- **Chrome built-in AI (Prompt API / Gemini Nano)** — the default when your Chrome build supports it.
  Chrome manages the model and shares it across the browser. The Settings page has a one-time **“Set
  up”** button when Chrome needs to download it.
- **Local models (Transformers.js)** — the fallback. `Automatic` uses the recommended **Qwen3 0.6B**
  (loads reliably on the widest range of hardware); **Qwen3 1.7B** is opt-in for higher quality, and
  **FLAN-T5 Base** is a lightweight compatibility option. All are `onnx-community/*-ONNX` builds. The
  catalogue lives in [`src/shared/models.ts`](src/shared/models.ts).

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
- Transformers.js (ONNX Runtime Web) with WebGPU + WASM · Qwen3 SLMs
- `Intl.Segmenter` · CSS Custom Highlight API
- Vitest · ESLint · Prettier

## 🔒 Privacy

Your text is checked **entirely on your device** and is never sent to the
developer or any third party. The extension has no servers, no accounts, no
analytics, and no tracking. Settings and downloaded model files are stored
locally. See the full [Privacy Policy](PRIVACY.md).

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
