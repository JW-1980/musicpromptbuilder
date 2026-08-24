<!-- Filename: docs/FEATURE-MECHANICS.md -->
# FEATURE MECHANICS & ALGORITHMIC BLUEPRINT

This document defines the exact logic, mathematical rules, and behavioral constraints for the complex features listed in the Master FDD. The AI coding agent MUST follow these mechanics strictly to prevent hallucinated logic.

---

## 1. AUDIO & DSP MECHANICS

### 1.1 Direct MIDI Export Logic
* **Requirement:** The agent cannot use external MIDI libraries. It must construct a base64-encoded Standard MIDI File (SMF) format 0 directly in memory.
* **Math:** The extracted Fundamental Frequency (F0 in Hz) must be converted to MIDI Note Numbers using the formula: `n = round(69 + 12 * log2(F0 / 440))`.
* **Logic:**
  1. The Web Worker tracks F0 and stores it in an array alongside timestamp deltas.
  2. The agent must implement a function that groups consecutive identical note numbers into a single MIDI `note_on` and `note_off` event pair.
  3. The resulting binary string is converted to `data:audio/midi;base64,...` and triggered as a download.

### 1.2 YIN Algorithm vs. Naive Autocorrelation
* **Requirement:** Standard autocorrelation is prone to subharmonic errors (octave jumps). The agent must implement a lightweight YIN algorithm inside the Web Worker for the `WebAudio` processing.
* **Step 1 - Difference Function:** Calculate how different the signal is at each lag (τ): `d(τ) = sum((x[j] - x[j+τ])^2)`
* **Step 2 - Cumulative Mean Normalization:** Smooth the difference curve to reduce false positives at lag zero.
* **Step 3 - Absolute Thresholding:** Set the detection threshold to 0.1. The algorithm selects the first τ where the normalized difference is < 0.1.
* **Step 4 - Parabolic Interpolation:** Apply parabolic interpolation around the local minimum to find the true pitch period with sub-sample precision.
* **Performance Constraint:** The YIN function must process 2048-sample buffers at 44.1kHz without exceeding 5ms of execution time inside the Web Worker.

### 1.3 Auto-BPM & Onset Transient Detection
* **Logic:** The tempo is calculated by analyzing the spectral flux (energy changes) across successive FFT frames.
* **Algorithm:**
  1. Calculate the energy envelope of the signal.
  2. Compute the first derivative of the energy envelope to detect sudden spikes (onsets).
  3. Filter onsets using a dynamic threshold (e.g., `1.5 * local_mean`).
  4. Measure the Inter-Beat Intervals (IBI) in milliseconds between valid onsets.
  5. Compute the median IBI over a 4-second sliding window to reject outliers.
  6. **BPM Translation:** `BPM = 60000 / median_IBI`.
* **UI Binding:** The "Visual BPM Metronome" pulses a CSS `box-shadow` on the main container at an interval of `60000 / BPM` milliseconds.

### 1.4 Pitch Sanitizer & Snapping
* **Logic:** Human humming is naturally microtonal. Before mapping valence, the agent must snap the raw F0 to the nearest 12-TET (12-Tone Equal Temperament) pitch. 
* **Rule:** Calculate the nearest MIDI note, then convert it back to the exact scale frequency. Any frequency deviation (cents) must be ignored for the final prompt analysis.

### 1.5 3D WebGL Frequency Visualizer (Interactive Ribbon)
* **Requirement:** The oscilloscope must render via WebGL (using raw WebGL 2.0 or an embedded lightweight `Three.js` implementation). 
* **Mechanics:** 
  * The time-domain buffer maps to the Z-axis (depth) and Y-axis (amplitude) of a ribbon.
  * **Dynamic Colors:** The RGB values of the shader must interpolate based on the detected Harmonic Valence. 
    * Major Mode detected -> `vec3(0.0, 0.94, 1.0)` (Neon Cyan).
    * Minor Mode detected -> `vec3(0.54, 0.17, 0.89)` (Electric Violet).

---

## 2. LYRIC & TEXT ARCHITECT MECHANICS

### 2.1 Lyric Syllable Heatmap
* **Logic:** Since we cannot use heavy NLP libraries, the agent must use a regex-based heuristic to estimate syllables per line.
* **Heuristic Rule:** Count vowels (`a, e, i, o, u, y`). Subtract 1 for silent 'e' at the end of words. Subtract 1 for consecutive vowels (diphthongs). 
* **Heatmap Threshold:** 
  * If syllables per line > (BPM / 10), color the line amber (warning: too fast to sing).
  * If syllables per line > (BPM / 8), color the line crimson (error: will cause Suno to mumble or rush).
  * Otherwise, color it green.

### 2.2 Rhyme Scheme Highlighter
* **Logic:** The editor must parse the last word of every line.
* **Rule:** It converts the last word to its phonetic ending (matching the final vowel sound). If Line 1 and Line 2 share an ending, highlight both words in Cyan (AABB). If Line 1 and Line 3 share an ending, highlight in Violet (ABAB).

### 2.3 Auto-Chorus Refrain
* **Logic:** If the user creates a `[Chorus]` block in the drag-and-drop builder, the engine stores the text inside it. 
* **Rule:** When the prompt is compiled, if the structure ends without a final chorus, the engine must automatically append `[Chorus]` and the exact stored text before the `[Outro]` metatag to force Suno to recall the melody.

---

## 3. SUNO V5.5 METATAG & ARRANGEMENT COMPILER

### 3.1 Suno v5.5 Metatag Validation Rules
* **Requirement:** Suno v5.5 uses specific structural bracket tags to map the song architecture. The agent must ensure only valid tags from the official taxonomy are injected.
* **Core Base Tags:** `[Intro]`, `[Verse]`, `[Pre-Chorus]`, `[Chorus]`, `[Post-Chorus]`, `[Bridge]`, `[Outro]`, `[End]`.
* **Special Action Tags:** `[Instrumental]`, `[Interlude]`, `[Break]`, `[Drop]`, `[Build]`, `[Hook]`.
* **Rejection Rule:** The parser must automatically strip hallucinated or invalid tags (e.g., `[Epic Solo Part 2]`) and replace them with standard tags (e.g., `[Guitar Solo]`).

### 3.2 Three-Level Tag Hierarchy
* **Logic:** Suno v5.5 arrangement control works best when metatags carry short, localized modifiers. The UI Structure Builder must compile tags using this three-level hierarchy:
  1. **Section:** e.g., `[Verse 1]`
  2. **Local Change / Modifier:** e.g., `intimate, sparse`
  3. **Compiled Output:** `[Verse 1 - intimate, sparse]`.
* **Constraint:** Modifiers inside brackets must not exceed 4 comma-separated terms to prevent prompt overloading. Discard lowest-priority traits if exceeded.

### 3.3 Negative Tag Shield (Exclusion Logic)
* **Logic:** Negative prompting in v5.5 is handled explicitly via the `[Exclude: ...]` tag. 
* **Compiler Rule:** The engine collects all toggled exclusions from the "Negative Tag Shield" UI. It must concatenate them into a single bracketed block at the very end of the prompt string: `[Exclude: harsh noise, male vocals, acoustic guitars]`. 

---

## 4. TRI-AXIS SLIDER MAPPING ALGORITHMS

The agent must translate the 0-100 values of the visual sliders into linguistic tags.

### 4.1 Energy Slider (E)
* **E < 30:** Injects `[low energy, slow-tempo, restrained, acoustic, soft dynamics]`.
* **30 <= E <= 70:** Injects no overriding energy tags (relies on base genre).
* **E > 70:** Injects `[high energy, driving rhythm, explosive, heavy compression, loud dynamics]`.

### 4.2 Warmth Slider (W)
* **W < 30 (Cold/Digital):** Injects `[cold digital master, clinical mix, sterile, digital synthesis, wide stereo, hyper-clean]`.
* **30 <= W <= 70:** Injects no overriding warmth tags.
* **W > 70 (Analog/Warm):** Injects `[warm analog saturation, vintage tube preamp, tape hiss, vinyl crackle, natural room acoustics]`.

### 4.3 Density Slider (D)
* **D < 30 (Sparse):** Injects `[minimalist arrangement, sparse instrumentation, intimate, stripped down, raw]`.
* **30 <= D <= 70:** Injects no overriding density tags.
* **D > 70 (Wall of Sound):** Injects `[wall of sound, dense arrangement, massive orchestration, heavily layered, complex production]`.

---

## 5. GAMIFICATION & SCORING MECHANICS

### 5.1 Prompt Synergy Score (0-100)
* **Base Score:** Starts at 100.
* **Deduction Rules:**
  * -20 points if > 5 specific instruments are selected (Clutter warning).
  * -30 points for known acoustic conflicts (e.g., tagging both `lo-fi cassette hiss` and `modern hyper-clean radio master`).
  * -15 points if the lyrics exceed the Syllable Heatmap safe limits.
* **UI Behavior:** The score updates dynamically. If it drops below 70, a small tooltip must explain the deductions (e.g., "Mix is getting muddy").

### 5.2 Suno Credit Cost Estimator
* **Logic:** Suno v5.5 charges 5 credits per single generation (which yields 2 audio tracks).
* **Rule:** If the user selects the "Batch Variation Matrix" (generating 5 variations), the estimator must dynamically calculate and display: `Estimated Cost: 25 Credits`.

---

## 6. UI, STATE & PWA MECHANICS

### 6.1 Fluid View Transitions
* **Logic:** The agent MUST use the native `document.startViewTransition()` API.
* **Rule:** When switching from the Hum Interface to the Text Editor, the elements must not simply disappear. The canvas must fade out, and the text editor must slide up from the bottom. Fallback gracefully to standard DOM swapping if unsupported.

### 6.2 Workspace Profiling (State Management)
* **Logic:** A profile is a serialized JSON object containing the state of all sliders, selected genres, and active metatags.
* **Rule:** The agent must store these in `localStorage` under `suno_profiles`. When a user clicks "Save as Profile", it takes a snapshot of the current DOM state. Loading a profile must synchronously update the DOM and recalculate the character limit.

### 6.3 Dual-Prompt Breeding
* **Logic:** The user selects Prompt A and Prompt B from their history.
* **Rule:** The agent parses the tokens from both. It takes the Tempo/Key from Prompt A, the Genre/Instruments from Prompt B, and interleaves them. It must filter out duplicates before compiling the new hybrid string.

### 6.4 IndexedDB Storage Hook
* **Requirement:** `localStorage` is synchronous and limited to 5MB.
* **Agent Rule:** Implement an asynchronous `IndexedDB` wrapper (using vanilla Promises) for the `presets` and `prompt_history` tables. `localStorage` is strictly reserved for lightweight UI state (e.g., dark mode toggle).

### 6.5 Wake Lock API
* **Logic:** To prevent the phone from sleeping while the user is humming a long melody.
* **Rule:** Implement `navigator.wakeLock.request('screen')` during recording and release it when stopped.

### 6.6 PWA Share Target Integration
* **Logic:** Allows mobile users to share text from a notes app directly into the prompt builder.
* **Rule:** Add the `share_target` field to the `manifest.json`. The `index.html` initialization script must parse `new URLSearchParams(window.location.search).get('lyrics')` and automatically populate the Lyrics text editor.

---

## 7. AI DISSECTOR & LOCAL MODEL MECHANICS

### 7.1 Mode 1: WebGPU / WASM Local Engine Setup
* **Library:** Use `@huggingface/transformers` (Transformers.js v3).
* **Worker Isolation:** The model MUST be instantiated inside a dedicated Web Worker (`ai-worker.js`) to prevent freezing the DOM during the multi-megabyte weight download and tensor inference.
* **Streaming UI:** The agent must implement a listener for the `progress` callback to display a progress bar calculating `(loaded / total) * 100` for the model shards.
* **Sampling Parameters:** Configure the pipeline with `temperature: 0.1` and `top_k: 10` for deterministic JSON.

### 7.2 Token Probability Heatmap Extraction
* **Logic:** When using the local WebGPU model, the agent must extract the generation logits.
* **Rule:** Access the probability scores for the tokens comprising the `genre_tokens` array. Map the probability (0.0 to 1.0) to a CSS opacity scale (0.4 to 1.0) on the resulting genre badges in the UI.

### 7.3 Automated Fallback Chaining
* **Logic:** The agent must implement a `try/catch` waterfall for the AI extraction.
* **Rule Sequence:**
  1. Attempt `fetch()` to Cloud API (Mode 2). 
  2. If response is `429 Too Many Requests` or timeout > 3000ms, catch the error silently.
  3. Initialize the WebGPU/WASM local model (Mode 1).
  4. Display a toast notification: *"Cloud API busy. Falling back to local offline model."*

### 7.4 Prompt Diff Viewer
* **Logic:** When the AI Dissector generates an optimized prompt from a user's layman text, the UI must show the changes.
* **Rule:** The agent must run a basic string difference algorithm (comparing words). Words present in the original input but missing in the AI output are wrapped in `<span class="diff-removed">` (colored red, strikethrough). New Suno-specific tokens added by the AI are wrapped in `<span class="diff-added">` (colored green).

### 7.5 Batch Dissection Parsing
* **Logic:** The user pastes a playlist or DJ setlist (up to 5 tracks).
* **Agent Rule:** The prompt compiler wraps the track list in the prompt instruction: `Identify the overlapping acoustic traits, median BPM, and primary genre that unites the following 5 tracks: [TRACK_LIST]. Return only the unifying traits in the JSON schema.`