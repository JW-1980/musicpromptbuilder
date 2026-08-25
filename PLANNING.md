# PLANNING.md
**File:** `PLANNING.md`

## NOW
- [ ] *(queue exhausted — v1.1.0 tagged; audited next-queue below awaits owner direction)*

## NEXT
*v1.1.0 audit recommendations, by value × leverage on existing engines:*
- [ ] #49 Pure Instrumental Mode Lock (the conflict rule already exists, currently unreachable — one toggle activates it).
- [ ] #81 Tag Clutter Warning (>15 instruments; counts already tracked; in-code marker names it unimplemented).
- [ ] #83 Prompt Synergy Score (§5.1 spec; every input already computed by #73/#68).
- [ ] #76 Batch Variation Matrix (reuse createSeededRng over the deterministic compiler).
- [ ] #57 Prompt Diff Viewer (pure compiler + history bank already stores both sides).
- [ ] #45 Duet & Multi-Vocalist Cues (joins the 104-persona registry to the structure sheet).
- [ ] #12 Visual BPM Metronome (the last user-visible payoff of the onset/BPM tracker).
- [ ] #94 Markdown/Text Exporter (data: download path proven twice already).
- [ ] Fix: `#mic-help` never opens on NotFoundError/NotReadableError (no-microphone case; pre-existing since v1.0.0).
- [ ] Fix: `.theme-switching` release uses rAF, which parks in hidden tabs (cosmetic; use a visibility-safe fallback).
*Runners-up:* #46 solo cues, #19 onboarding tour, #72 A/B splitter.

## DONE
- [x] #90 Studio Shortcut Keybinds + #16 Command Palette (central dispatcher, 537-entry palette over the real toggle paths, cheat sheet; auto-repeat + a11y review fixes).
- [x] Fix: theme-swap transition freeze — pattern-level `.theme-switching` kill class in repaintTheme (Tasks 11/14 diagnosis closed).
- [x] Resolved: Code Mode violet legibility — already fixed by Task 17's raised pin (#B77CED, 7.12:1) + `--ink-violet` for text (10.13:1 in Code Mode).
- [x] #69 Suno Model Selector (conservative documented knobs, v5.5 byte-identity) + #75 URL-hash deep linking (checksummed base64url, hostile-input-proof).
- [x] #71 "Inspire Me" (single-genre synergy guarantee, seeded RNG, never auto-adds) + #27 Instrument Lego Blocks (87-block registry derived from MUSIC_KB + curated staples).
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