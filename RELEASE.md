# SunoPrompt Studio — Release Notes

## v1.1.0 — 2026-08-25

**Artifact:** a single, offline-capable, zero-dependency `index.html` (1.15 MiB, 31,441 lines) that runs via `file://`.
**Verification at tag time:** 21 Node suites — **1,038 passed / 0 failed / 15 honest todos**; overnight E2E GREEN; single-file integrity 43/43; release browser pass clean (zero console messages, zero external network requests across the full golden path including reload/restore).

### Honest scope statement

**40 features fully implemented + 9 partial, of the FDD's 94 auditable features** (v1.0.0: 31 + 6).
Ten features gained: #16 command palette, #25 decade time-machine, #27 instrument blocks,
#28 vocal persona selector, #65 vocal registries (104 timbres), #66 production eras
(124 signatures), #69 model selector, #71 Inspire Me, #75 deep linking, #90 studio keybinds.
One re-graded stricter, none regressed — all 31 v1.0.0 features still exercise end-to-end.
Zero stubs: absent features are absent, and several carry in-code markers saying so.

### Beyond the matrix, since v1.0.0

- **Owner-directed:** refined WebGL ribbon (honesty-gated twist, perceptual amplitude,
  60fps interpolation, lighting/fog); zoned Prompt Editor workspace with a sticky compile
  rail; a 7-theme suite (Obsidian, Daylight, CVD-verified Studio ColorSafe, Tape Deck,
  Null Signal, Abyssal Bloom, Studio Code) with a registry-driven picker; **local AI as
  the default dissector mode** — Qwen2.5-0.5B (SmolLM2-360M lighter option) behind an
  explicit, SHA-256-pinned opt-in download with the taxonomy engine answering instantly
  until weights exist; an AES-GCM key vault with epoch-guarded arming ("remember on this
  device", one-click disarm); OpenRouter + OpenAI-compatible + Gemini presets.
- **Quality process:** every task shipped through implementation + adversarial review
  workflows; reviews caught and forced fixes for a decorative disarm button, a hash-gate
  bypass, two millisecond-level arming races, a sub-AA text token (now `--ink-violet`),
  auto-repeat key re-firing, and more — nothing landed on a red or unreviewed tree.

### Versioning convention (settled by the v1.1.0 audit)

`APP_VERSION` bumps per task between releases; a release commit aligns `APP_VERSION`,
`package.json`, and the git tag to one number. This release: **1.1.0** everywhere.

### Known notes (queued, non-blocking)

- `#mic-help` doesn't open on `NotFoundError`/`NotReadableError` (no-mic hardware case);
  pre-existing since v1.0.0.
- The theme-swap transition kill releases via `requestAnimationFrame`, which parks in
  hidden tabs (cosmetic, self-healing on focus).
- #89 installability is honestly partial: a `data:` manifest cannot trigger Chrome's
  install prompt and a single file cannot ship a service worker — documented in-code.

---

## v1.0.0 — 2026-08-25 *(superseded)*

31 implemented + 6 partial of 94 auditable features; 576 tests / 13 suites; ~612 KB.
First release: DSP engine (YIN/RMS/BPM/valence), Tri-Mode dissector (embedded taxonomy),
structure builder, 1,000-char compiler with conflict resolution, MIDI export, persistence
with Workspace Profiling, theming (dark/light + Code Mode), overnight E2E harness.
