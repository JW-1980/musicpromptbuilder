# SunoPrompt Studio — v1.0.0 Release Notes

**Date:** 2026-08-25
**Artifact:** a single, offline-capable, zero-dependency `index.html` (~612 KB) that runs via `file://`.
**Verification at tag time:** 13 Node suites — **576 passed / 0 failed / 12 honest todos**; overnight E2E GREEN; single-file integrity 24/24; release browser pass clean (zero console messages across the full golden path, including reload/restore).

## Honest scope statement

The FDD defines a 99-feature matrix (95–99 are backend-schema reservations). This release ships
**31 features fully implemented and 6 partially implemented, of the 94 auditable features** —
established by a strict code-level audit (a feature counts only if a user can exercise it
end-to-end in the app; no stubs exist anywhere, absent features are absent, not faked).
The original planning queue's "all 50 features" phrasing was aspirational and does not describe
this tag.

| Domain | Implemented | Partial |
|---|---|---|
| A — Voice, DSP & Audio Intelligence | #1 pitch extraction (YIN), #3 harmonic valence, #8 pitch sanitizer (12-TET), #10 direct MIDI export | #2 auto-BPM (onset-based; no tap tempo) |
| B — UI, Visualization & UX | #11 3D WebGL ribbon, #14 view transitions, #17 high-contrast Code Mode, #18 ARIA optimization, #20 container queries, #21 DOM virtualization | #15 syntax color scheme (chips, not rich-text editor) |
| C — Vibe & Emotion Translators | #22 scene generator, #23 tri-axis sliders, #24 safe-mode artist dissector, #30 negative tag shield | #25 decade triggers (partial era coverage) |
| D — Song Structure | #39 drag-and-drop flow canvas, #40 undo/redo, #42 metatag library, #50 auto-chorus refrain | — |
| E — AI Dissector | #58 batch dissection | #59 confidence display (aggregate, no per-token heatmap) |
| F — Taxonomy | #61 Afro house/amapiano DNA, #62 French electro/bloghaus, #63 progressive trance/Scandi house | #66 production eras (7 entries vs the 100+ specified) |
| G — Workflow & Power Tools | #67 1,000-char gauge, #68 conflict resolver, #73 token weighting, #74 history + favorites, #77 workspace profiling (Neon/Aetheris) | #70 segmented copy (Style/Lyrics/Draft; no Combined) |
| H — Architecture & Portability | #84 single-file engine, #85 offline-first storage, #86 JSON preset backup/restore, #93 clipboard JSON export | — |

Also in this release, beyond the matrix: the Tri-Mode AI Dissector (embedded offline taxonomy
engine + cloud adapter + Ollama hook with silent fallback chaining — Mode 1 is a deterministic
knowledge engine, not a downloaded LLM; see `ASSUMPTIONS.md`), a full theming system
(configurable color tokens, dark/light switcher, Studio Daylight light theme — owner request),
and the overnight E2E harness with Neon/Aetheris seed profiles.

**Re-scoped to post-1.0:** FDD #65 (80+ vocal timbres — currently no registry) and the balance
of #66 (100+ production eras). The recommended post-1.0 queue is in `PLANNING.md`.

## Known notes

- The four pending items the nightly suite reports (browser-driver DOM interaction, live
  cloud/Ollama E2E, real WebGPU LLM provider, real-browser IndexedDB/clipboard in CI) are
  documented environment/scope limits, not failures.
- Pre-existing cosmetic issue: `.btn-record`'s CSS transition can freeze paint on a runtime
  theme swap in Chrome (diagnosed; fix queued separately).
