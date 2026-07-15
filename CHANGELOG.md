# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-07-15

### Added

- First-install onboarding that opens Settings and downloads the selected local
  model with visible progress, retries, and setup persistence.
- Device-specific model-cache completion markers and cleanup for interrupted or
  partial downloads.

### Changed

- Automatic acceleration now prefers a previously successful local backend and
  falls back without repeating setup downloads.
- Model download, deletion, retargeting, suspension, and cache cleanup now share
  coordinated lifecycle handling.

### Fixed

- Stale setup responses, rapid model/device changes, duplicate requests, and
  obsolete queued downloads can no longer complete or block the wrong target.
- Popup initialization, settings updates, Settings shortcuts, and retry failures
  now surface errors instead of producing unhandled promise rejections.
- Warmup and retry requests now report loading immediately instead of returning
  a stale idle status.

## [1.0.0] — 2026-07-12

### Added

- Runtime-message schema validation and sender-role authorization for content,
  popup, options, background, and offscreen contexts.
- Release-artifact verification for required files, ONNX Runtime references,
  checkout-path leaks, and package-size regressions.
- Third-party notices and license texts in production builds.
- Repository-wide formatting enforcement in local checks and CI, with stable LF
  line endings across platforms.
- Regression coverage for settings normalization, concurrent writes, selection
  targeting, offscreen creation, inference failures, and protected rich-editor
  content.
- Initial public release.
- On-device grammar, spelling, and punctuation correction with zero edited text
  leaving the browser.
- Chrome built-in AI (Prompt API / Gemini Nano) engine with automatic fallback
  to local Transformers.js models (Qwen3 0.6B / 1.7B, FLAN-T5 Base).
- WebGPU acceleration with a locally bundled WASM fallback.
- Inline wavy-underline highlights for `contenteditable`, `<textarea>`, and
  `<input>` fields using the CSS Custom Highlight API and positioned overlays.
- Hover/tap tooltip to accept or dismiss a suggestion.
- Built-in popup editor with an instant diff view and one-click copy.
- Right-click correction for selected text and configurable engines, models,
  acceleration, typing delay, fields, and per-site rules.

### Changed

- Model loading is demand-driven: installation, popup opening, and settings
  changes no longer initiate a large local-model download.
- Offscreen creation, shutdown, configuration, warmup, inference, and download
  work are serialized to avoid model races and overlapping memory use.
- The production extension is about 35.7 MiB instead of 74.5 MiB after removing
  unreferenced ONNX Runtime variants.
- Popup and options controls now expose complete keyboard, focus, live-region,
  progress, and reduced-motion behavior.
- Extension-page network access is restricted to local files and documented
  Hugging Face model hosts/CDNs.
- Site lists, locales, models, enums, and numeric settings are validated and
  canonicalized before use; concurrent settings updates are serialized.
- ESLint and Prettier were updated to their latest compatible patch releases.

### Fixed

- Model output cleanup no longer strips legitimate quotes, label-like text,
  literal think tags, or line-wrapped answers.
- Hallucination detection now counts inserted words and rejects expansions at
  the configured rewrite threshold.
- Invalid locales, unpunctuated lines, and oversized unspaced Unicode text no
  longer break or bypass sentence limits.
- Inference errors are surfaced instead of being reported as clean text;
  WebGPU-only mode no longer silently falls back to CPU, and lower-memory
  quantizations remain eligible after allocation failures.
- Selection corrections remain bound to the original field and range when
  focus moves or asynchronous requests resolve out of order.
- Rich-editor corrections cannot modify `contenteditable=false` tokens or
  hidden/non-rendered subtrees.
- Field corrections preserve selections, emit cancelable `beforeinput` and
  composed input events, remain visible in shadow-root editors, and revalidate
  field safety immediately before checking or applying.
- Popup corrections preserve leading and trailing whitespace, end insertions
  remain visible, and generic LRU eviction handles `undefined` keys correctly.
