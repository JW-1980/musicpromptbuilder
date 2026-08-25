# PLANNING.md
**File:** `PLANNING.md`

## NOW
- [ ] Build out the 'Prompt Editor' view (owner request): grow it from stacked cards into a coherent editor workspace — layout hierarchy, workflow ordering, and whatever editing affordances make prompt assembly genuinely fluid. *(Synthesized 7-change plan banked from workflow wf_d84cb3a5-672.)*

## NEXT
*Owner requests (2026-08-25), in order:*
- [ ] Theme suite via Stitch Pro (owner request): use the Stitch MCP **Pro model** for design references; ship as selectable themes — dark (Obsidian), light (Daylight), a colorblind-safe theme, a high-contrast theme (fold/reconcile with existing Code Mode), plus 3 original themes of our own design. All through the existing token layer with WCAG verification.

- [ ] Local AI as default (owner request 2026-08-25): make Mode 1 (local, in-browser) the default dissector mode and upgrade it to the most powerful of the FDD-named local models — Qwen2.5-0.5B via WebGPU with WASM fallback (lazy opt-in weight download with progress bar per FDD §3; the embedded taxonomy engine stays as the instant/offline fallback). *Note: this owner request relaxes the earlier "no runtime downloads" reading for Mode 1 — record the decision in ASSUMPTIONS.md when implementing.*
- [ ] API key persistence + provider focus (owner request 2026-08-25): keep offering cloud APIs; add opt-in "remember key on this device" so users never re-enter keys — encrypted at rest via WebCrypto (AES-GCM), with honest UI copy about what browser storage can and cannot protect. Providers: OpenAI-compatible endpoints (generic base-URL + model) and OpenRouter as the first-class presets; per-provider key slots.

*Post-1.0 recommendations from the release audit, in order:*
- [ ] #66 Expanded Production Eras (grow 7 → 100+ signatures on the existing era path). *(124 entries already generated and banked by workflow wf_5c2842df-17a — integration pending.)*
- [ ] #89 PWA Offline Manifest (small, high-leverage for the offline-first promise).
- [ ] #71 "Inspire Me" Slot Machine (reuses KB + prompt state wholesale).
- [ ] #27 Modular Instrument "Lego Blocks" selector.
- [ ] #28 Vocal Persona Selector (UI over #65's registry).
- [ ] #69 Suno Model Selector (v5.5/v4/v3.5 syntax switch in the centralized compiler).
- [ ] #75 Base64/URL-Hash Deep Linking (serializeWorkspace already exists).
- [ ] #90 Studio Shortcut Keybinds (guard infrastructure already in place).
- [ ] #16 Command Palette (after #90's keybind layer).
- [ ] Fix: CSS transitions freeze paint on runtime theme swap in Chrome — affects `.btn-record` (Task 11) AND `.btn-mini` (re-confirmed in Task 14's persona toggle, nonsense 1.16:1 contrast mid-transition). Fix the pattern, not one button.
- [ ] Consider: Code Mode violet accent at 3.52:1 on black (noted in Task 7).

## DONE
- [x] Refine the waveform visualization (owner request): honesty-gated twist, perceptual amplitude curve, settle-on-stop, 60fps row interpolation, analytic lighting + fog, DPR-correct sizing, vignette/footlight.
- [x] #65 Expanded Vocal Registries (104 timbres) + #28 Vocal Persona Selector.
- [x] Run the comprehensive nightly E2E verification and tag `v1.0.0-release`. *(Audited honestly: 31 implemented + 6 partial of 94 FDD features — the original "50 features" phrasing was aspirational; see RELEASE.md.)*
- [x] Implement `localStorage` state persistence, virtualized DOM lists for presets, and JSON backup/restore.
- [x] Develop the `.mid` export function, translating the tracked pitch contour into MIDI events for direct import into Ableton or FL Studio.
- [x] Implement the Live 1,000-Character Limiter, Token Compactor, and Tag Conflict Resolution Engine. *(GATE 0 fully closed.)*
- [x] Build the Drag-and-Drop Structure Builder (`[Intro]`, `[Chorus]`, etc.) with the `Ctrl+Z` undo/redo stack.
- [x] Implement Layman Vibe Translators (Scene generator, 3-axis physical sliders, Safe-Mode artist dissector).
- [x] Full theming system (owner request): configurable color tokens, dark/light switcher, Studio Daylight light theme.
- [x] Implement the 3D WebGL Frequency Visualizer and bind it to the Web Worker's output array.
- [x] Scaffold the Obsidian Studio CSS layout using CSS Container Queries and native View Transitions.
- [x] Build the Tri-Mode Universal AI Dissector (WebGPU/WASM in-browser engine, Free Cloud APIs, and Local Ollama hook). *(Mode 1 = embedded taxonomy engine per ASSUMPTIONS.md — no LLM download possible under the zero-dependency constraint.)*
- [x] Write the background Web Worker for Autocorrelation ($F_0$) and RMS noise gating to keep the UI thread strictly at 60 FPS.
- [x] Implement the `WebAudio` and `AnalyserNode` boilerplate in Vanilla JavaScript, ensuring zero external framework dependencies.
- [x] Initialize repository structure, create empty `index.html`, and scaffold the Web Worker DSP test harnesses for overnight E2E execution.
- [x] Master Functional Design (FDD) and Agent Directives finalized and approved.