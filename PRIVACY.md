# Privacy Policy — Grammar Check SLM

**Last updated: July 12, 2026**

Grammar Check SLM ("the extension") is a privacy-first browser extension that
checks and corrects grammar, spelling, and punctuation **entirely on your own
device**. This policy explains, in plain language, exactly what the extension
does and does not do with your data.

## Summary

- **We do not collect any data.** The developer has no servers and receives
  nothing from you.
- **Your text never leaves your device for correction.** All grammar checking
  runs locally in your browser using either Chrome's built-in AI (Gemini Nano)
  or a local model (Transformers.js) via WebGPU/WASM.
- **No analytics, no tracking, no telemetry, no advertising, no cookies.**
- **No accounts, no sign-in.**

## What data the extension processes

### Text you are editing

When grammar checking is enabled for a site, the extension reads the text you
type or paste into editable fields (rich-text editors, `<textarea>`, and text
`<input>` elements) so it can check it. This text is processed **only in
memory, on your device**, and is passed to an on-device language model to
produce corrections. It is:

- **Never** sent to the developer.
- **Never** sent to any third-party server for correction.
- **Never** stored persistently. A bounded in-memory cache of recent results is
  kept only to avoid re-checking unchanged sentences. It can remain while the
  offscreen model runner is active and is cleared when the runner is disabled,
  reconfigured, closed, or the browser session ends.

### Settings

Your preferences (enabled state, chosen engine/model, typing delay, per-site
allow/deny lists, and field toggles) are stored **locally** on your device using
`chrome.storage.local`. They are not transmitted anywhere and are not synced to
any account.

### Downloaded model files

If you use a local model, the extension downloads the model's weight files from
the **Hugging Face** model hub (`huggingface.co` and its CDN) the first time
that model is used, and caches them locally for offline use. This request
downloads model files only — **no text you are editing and no personal
information is included** in it. Chrome's built-in AI (Gemini Nano) is provided
by your browser and requires no download from the extension.

As with any file download, the model host receives standard connection metadata
such as your IP address and browser user agent. It does not receive text you are
editing. Hugging Face's handling of that request is governed by its privacy
policy: <https://huggingface.co/privacy>. Chrome may separately download and
manage Gemini Nano when you choose its one-time setup; that download is handled
by the browser, not by this extension.

### Clipboard

The extension writes text to your clipboard **only when you explicitly ask it
to** — for example, by clicking a "Copy" button or accepting a correction for
read-only text. It never reads your clipboard.

## Permissions and why they are needed

- **`storage` / `unlimitedStorage`** — save your settings and cache downloaded
  model files locally (models can be several hundred megabytes).
- **`offscreen`** — run the local language model in a hidden document, which is
  required to use WebGPU/WASM from a Manifest V3 extension.
- **`contextMenus`** — provide the right-click "Correct grammar of…" action and
  the per-site toggle.
- **`activeTab`** — read the current tab's address in the popup so it can show
  and toggle checking for the site you are on.
- **`clipboardWrite`** — copy corrected text to your clipboard when you ask.
- **Host access (`<all_urls>`)** — a grammar checker must be able to run in the
  text fields on the pages where you write. You can restrict this at any time in
  Settings using the allow-list / deny-list, or disable the extension per site.

## Data sharing and selling

We do **not** sell, rent, share, or transfer any user data to anyone. We do not
have access to your data in the first place.

## Children's privacy

The extension does not knowingly collect any information from anyone, including
children.

## Changes to this policy

If this policy changes, the updated version will be published in the extension's
repository and the "Last updated" date above will be revised.

## Contact

Questions about this policy or the extension can be raised via the project's
issue tracker: <https://github.com/techtocore/Grammar-check-SLM/issues>.
