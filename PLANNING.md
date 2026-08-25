# PLANNING.md
**File:** `PLANNING.md`

## NOW
- [ ] #71 "Inspire Me" Slot Machine + #27 Modular Instrument "Lego Blocks" — paired iteration (both are selector/generator features over the existing KB + prompt state).

## NEXT
*Post-1.0 recommendations from the release audit, in order:*
- [ ] #28 Vocal Persona Selector (UI over #65's registry).
- [ ] #69 Suno Model Selector (v5.5/v4/v3.5 syntax switch in the centralized compiler).
- [ ] #75 Base64/URL-Hash Deep Linking (serializeWorkspace already exists).
- [ ] #90 Studio Shortcut Keybinds (guard infrastructure already in place).
- [ ] #16 Command Palette (after #90's keybind layer).
- [ ] Fix: CSS transitions freeze paint on runtime theme swap in Chrome — affects `.btn-record` (Task 11) AND `.btn-mini` (re-confirmed in Task 14's persona toggle, nonsense 1.16:1 contrast mid-transition). Fix the pattern, not one button.
- [ ] Consider: Code Mode violet accent at 3.52:1 on black (noted in Task 7).

## DONE
- [x] #89 PWA Offline Manifest + #92 Share Target parsing (honest single-file scope: data-URI manifest with theme-tracking colors, share-intent lyrics import, event-gated install affordance).
- [x] #66 Expanded Production Eras: 124-signature registry (9 groups) with searchable, group-filtered selector card.
- [x] Local AI as default + API key persistence + provider focus (owner requests, incl. Gemini-stays correction): local-llm default mode with hash-pinned opt-in Qwen2.5-0.5B/SmolLM2 engine, AES-GCM key vault with epoch-guarded arming, OpenRouter/OpenAI-compatible/Gemini presets.
- [x] Theme suite via Stitch Pro (owner request): 7 selectable themes — Obsidian, Daylight, Studio ColorSafe (CVD-verified), Tape Deck, Null Signal, Abyssal Bloom, Studio Code (Code Mode reconciled); registry + accessible picker + dual-field persistence; AA enforced incl. the new --ink-violet text token.
- [x] Build out the 'Prompt Editor' view (owner request): zoned workspace — shape column + sticky compile rail, jump nav, heading hierarchy, primary-weight style card, focus management.
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