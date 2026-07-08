# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-07-08

### Added

- Initial public release.
- On-device grammar, spelling, and punctuation correction with zero data
  leaving the browser.
- Chrome built-in AI (Prompt API / Gemini Nano) engine with automatic fallback
  to local Transformers.js models (Qwen3 0.6B / 1.7B, FLAN-T5 Base).
- WebGPU acceleration with a WASM fallback, bundled locally for offline use.
- Inline wavy-underline highlights for `contenteditable`, `<textarea>`, and
  `<input>` fields using the CSS Custom Highlight API (with a positioned-overlay
  fallback).
- Hover tooltip to accept or dismiss a suggestion.
- Built-in popup editor with an instant diff view and one-click copy.
- Right-click "Correct grammar of…" action for selected text anywhere on a page.
- Configurable engine, model, acceleration, typing delay, checked field types,
  and per-site allow-list / deny-list rules.
