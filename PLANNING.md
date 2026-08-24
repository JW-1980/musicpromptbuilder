# PLANNING.md
**File:** `PLANNING.md`

## NOW
- [ ] Implement the Live 1,000-Character Limiter, Token Compactor, and Tag Conflict Resolution Engine.

## NEXT
- [ ] Develop the `.mid` export function, translating the tracked pitch contour into MIDI events for direct import into Ableton or FL Studio.
- [ ] Implement `localStorage` state persistence, virtualized DOM lists for presets, and JSON backup/restore.
- [ ] Run the comprehensive nightly E2E verification across all 50 features and tag `v1.0.0-release`.

## DONE
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