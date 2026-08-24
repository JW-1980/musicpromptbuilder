# ASSUMPTIONS.md
**File:** `ASSUMPTIONS.md`

## Architecture & UI Trade-offs
- **Vanilla JS over Frameworks:** Assuming the strict zero-dependency and single-file target (`index.html`) requires bypassing heavy frontend frameworks (like React or Vue) in favor of Vanilla JavaScript and modern native DOM APIs (Web Components, View Transitions). This mirrors the architecture needed for highly portable, client-side web tools.
- **Local Storage Quotas:** Assuming standard browser `localStorage` limits (~5MB). To prevent quota exhaustion, the history array will function as a FIFO ring buffer capped at 100 entries. Larger preset libraries will rely on JSON export/import.
- **Tri-Mode AI Fallback:** Assuming the user prioritizes cost and privacy, the Dissector will attempt Mode 1 (In-Browser WebGPU) first, falling back to Mode 2 (Cloud APIs) only if the hardware fails to allocate sufficient VRAM.

## Tooling & Environment
- **`.mcp.json` env-var syntax:** The directive (`docs/SUNO-AI-AGENT-DIRECTIVE.md` §1.1) shows Windows `%VAR%` syntax inside `.mcp.json`. Claude Code expands `${VAR}` (not `%VAR%`) in `.mcp.json` values, so `${STITCH_API_KEY}` / `${GEMINI_API_KEY}` are used instead. Secrets still live only in the environment; nothing is written to disk.
- **GATE 0 sequencing:** The GATE 0 items "Autocorrelation DSP unit test passing" and "character limiter unit test passing" can only pass once the YIN worker and prompt compiler exist (queue tasks 2–3 and 8). The test harness is scaffolded first with those suites registered as explicit `todo` entries; the nightly runner fails on *unexpected* failures but reports `todo` suites honestly. GATE 0 closes at the earliest moment the implementations land.
- **E2E without external frameworks:** The overnight E2E suite is pure Node (no Playwright/Puppeteer dependency) — it extracts the inline app/worker scripts from `index.html` by marker ID and executes them in `node:vm` sandboxes with minimal DOM/Worker stubs. This keeps the repo zero-dependency while still executing the real production code paths (no simulated logic).

## Audio & Hardware
- Assuming the user will primarily input melodies via chest humming, whistling, or vocal beatboxing. Polyphonic instrument input (like strumming a guitar into the mic) will be tracked monophonically, capturing only the loudest fundamental pitch.