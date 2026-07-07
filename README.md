# Grammar Check SLM 🔍✍️

A privacy-first browser extension that checks grammar **entirely on your device** using a local
Small Language Model (SLM). No text ever leaves your browser — inference runs locally with
[Transformers.js](https://github.com/huggingface/transformers.js), accelerated by **WebGPU** where
available and falling back to WASM everywhere else.

![Extension pop-up](/assets/pop-up.png)

## ✨ Features

- **🔒 Truly private** — all processing happens locally; nothing is sent to any server.
- **⚡ Chrome built-in AI** — uses Chrome's **Prompt API (Gemini Nano)** when available: no model
  download, shared across the browser, and highly efficient. Falls back automatically to a bundled
  model when it isn't.
- **🤖 Local SLM fallback** — Alibaba's **Qwen3 0.6B** (default) or **1.7B** via Transformers.js,
  accelerated by **WebGPU** (with a WASM fallback). FLAN-T5 is available for maximum compatibility.
- **🎯 Accurate mapping** — a real word-level **LCS diff** maps each fix to an exact text range, so
  suggestions are precise (no more guessing which word changed).
- **🧠 Sentence-aware** — uses `Intl.Segmenter` to check sentence-by-sentence and **caches** results,
  so unchanged text is never re-processed.
- **✒️ Works in real fields** — `contenteditable` editors **and** `<textarea>` / `<input>` fields.
- **✍️ Built-in Editor** — paste a sentence or paragraph into the popup for instant, on-device
  correction with a clean diff view and one-click **copy**.
- **🖱️ Right-click to correct** — select any text on a page and choose **“Correct grammar of …”** to
  fix it in place (editable fields) or copy the corrected version (read-only text).
- **🎨 Non-destructive highlights** — uses the modern **CSS Custom Highlight API** for rich-text
  fields (no DOM rewriting, no caret jumps) and a positioned overlay for inputs.
- **🛠️ Configurable** — pick a model, acceleration backend, typing delay, per-site rules, and more.

## 🏗️ Architecture

```
┌──────────────┐   check/warmup/status   ┌────────────────────┐   config/check   ┌───────────────────┐
│ Content      │ ──────────────────────▶ │ Service worker     │ ───────────────▶ │ Offscreen document│
│ script       │ ◀────── corrections ─── │ (router+lifecycle) │ ◀── corrections ─│ (Transformers.js) │
│  · adapters  │                         │  · settings        │                  │  · WebGPU / WASM  │
│  · highlighter                         │  · offscreen mgmt  │                  │  · Qwen3 SLM      │
│  · tooltip   │        settings         │  · context menu    │                  │  · diff + cache   │
└──────────────┘ ◀────────────────────── └────────────────────┘                  └───────────────────┘
```

- **`src/core`** — pure, fully unit-tested logic: tokenizer, LCS word diff, sentence segmentation,
  LRU cache, prompt building/cleanup, and correction assembly.
- **`src/offscreen`** — hosts the SLM (device selection, generation, caching).
- **`src/background`** — message router, offscreen lifecycle, settings, context menu.
- **`src/content`** — field discovery, adapters (contenteditable / input), highlighter, tooltip.
- **`src/popup` / `src/options`** — UI.
- **`src/shared`** — typed message protocol, settings storage, model catalogue, logger.

## 🚀 Getting started

### Prerequisites

- Node.js 20+
- A Chromium-based browser, version **116+** (for the offscreen + `getContexts` APIs). WebGPU
  (Chrome 113+) is used automatically when available.

### Build

```bash
npm install
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

The first check downloads the model from Hugging Face (cached afterwards for offline use). Pre-filled
fields are checked automatically; you'll see wavy underlines a moment after the model is ready. Open
the page's DevTools console to see `[GrammarSLM:content]` logs if you want to confirm checks are running.

![Suggested correction](/assets/suggestion.png)

## ⚙️ Configuration

Open the extension's **Settings** page (or the ⚙ button in the popup) to configure:

| Setting      | Description                                                                    |
| ------------ | ------------------------------------------------------------------------------ |
| Engine       | `Automatic` (Chrome built-in AI when available, else local), built-in only, or local only |
| Model        | Local fallback model: `Automatic`, Qwen3 0.6B / 1.7B, or FLAN-T5 Base           |
| Acceleration | `Automatic` (WebGPU → WASM), WebGPU only, or WASM only (local models)           |
| Language     | BCP-47 locale used for sentence segmentation                                   |
| Typing delay | Debounce before a check runs                                                   |
| Fields       | Toggle rich-text and/or input/textarea checking                                |
| Sites        | Run everywhere, only on an allow list, or everywhere except a deny list        |

Right-click the toolbar icon or any text field to quickly toggle checking on the current site.
Select text anywhere and right-click **“Correct grammar of …”** to correct it in place (or copy the
result for read-only text).

### Engines

- **Chrome built-in AI (Prompt API / Gemini Nano)** — the default when your Chrome build supports it.
  Nothing to download in the extension; the model is shared across the browser and very efficient.
  The Settings page has a one-time **“Set up”** button to download Gemini Nano if needed.
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

## 🙏 Acknowledgments

- [Hugging Face](https://huggingface.co/) for Transformers.js and the ONNX model conversions
- [Qwen team](https://github.com/QwenLM/Qwen3) for the Qwen3 models
- AI coding tools including GitHub Copilot

## 📄 License

MIT

---

**Made with ❤️ for privacy-conscious users**
