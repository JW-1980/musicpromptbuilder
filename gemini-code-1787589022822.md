# ASSUMPTIONS.md
**File:** `ASSUMPTIONS.md`

## Architecture & UI Trade-offs
- **Vanilla JS over Frameworks:** Assuming the strict zero-dependency and single-file target (`index.html`) requires bypassing heavy frontend frameworks (like React or Vue) in favor of Vanilla JavaScript and modern native DOM APIs (Web Components, View Transitions). This mirrors the architecture needed for highly portable, client-side web tools.
- **Local Storage Quotas:** Assuming standard browser `localStorage` limits (~5MB). To prevent quota exhaustion, the history array will function as a FIFO ring buffer capped at 100 entries. Larger preset libraries will rely on JSON export/import.
- **Tri-Mode AI Fallback:** Assuming the user prioritizes cost and privacy, the Dissector will attempt Mode 1 (In-Browser WebGPU) first, falling back to Mode 2 (Cloud APIs) only if the hardware fails to allocate sufficient VRAM.

## Audio & Hardware
- Assuming the user will primarily input melodies via chest humming, whistling, or vocal beatboxing. Polyphonic instrument input (like strumming a guitar into the mic) will be tracked monophonically, capturing only the loudest fundamental pitch.