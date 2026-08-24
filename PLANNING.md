# PLANNING.md
**File:** `PLANNING.md`

## NOW
- [ ] *(queue exhausted — awaiting owner direction; recommended post-1.0 queue below)*

## NEXT
*Post-1.0 recommendations from the release audit, in order:*
- [ ] #65 Expanded Vocal Registries (80+ timbres — currently absent; pure data work, pairs with #28).
- [ ] #66 Expanded Production Eras (grow 7 → 100+ signatures on the existing era path).
- [ ] #89 PWA Offline Manifest (small, high-leverage for the offline-first promise).
- [ ] #71 "Inspire Me" Slot Machine (reuses KB + prompt state wholesale).
- [ ] #27 Modular Instrument "Lego Blocks" selector.
- [ ] #28 Vocal Persona Selector (UI over #65's registry).
- [ ] #69 Suno Model Selector (v5.5/v4/v3.5 syntax switch in the centralized compiler).
- [ ] #75 Base64/URL-Hash Deep Linking (serializeWorkspace already exists).
- [ ] #90 Studio Shortcut Keybinds (guard infrastructure already in place).
- [ ] #16 Command Palette (after #90's keybind layer).
- [ ] Fix: `.btn-record` CSS transition freezes paint on runtime theme swap (Chrome; diagnosed in Task 11).
- [ ] Consider: Code Mode violet accent at 3.52:1 on black (noted in Task 7).

## DONE
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