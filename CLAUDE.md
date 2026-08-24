<!-- Filename: CLAUDE.md -->
# CLAUDE.md — SunoPrompt Studio Workspace

SunoPrompt Studio is an offline-capable, single-file prompt builder for Suno v5.5. It features a Web Worker DSP engine, direct MIDI export, a Tri-Mode Dynamic AI Dissector, and an optional PHP 8.4/SQLite sync backend.

## Document Hierarchy & Precedence
1. `docs/FDD.md`: Functional specs, 99-feature matrix, UI tokens, DSP math.
2. `docs/FEATURE-MECHANICS.md`: Blueprint for algorithmic generation and logic bounds.
3. `docs/SUNO-AI-AGENT-DIRECTIVE.md`: Autonomy protocols, E2E overnight testing, MCP pipelines.
4. `docs/ENGINEERING-STANDARD.md`: Code quality, Web Worker routing, anti-simulation rules.
5. `docs/PHP-SQLITE-QUALITY-CHECKLIST.md`: Backend/Frontend execution standards.
6. `CLAUDE.md`: Workspace entry point.

## Canonical Verification Commands
- **Verify Single-File Bundle:** `node tests/verify-single-file.js`
- **Run E2E Overnight Suite:** `npm run test:e2e:nightly`
- **Run Character Limiter Tests:** `node tests/limiter-eval.js`
- **Optional Backend Test:** `php -S 127.0.0.1:8000 -t backend/public`

## Non-Negotiable Rules
- **No External CDNs:** The primary `index.html` must remain 100% self-contained and run via `file://`.
- **Strict 1,000-Character Ceiling:** Suno v5.5 prompt limits must never be exceeded under any input configuration.
- **Environment Secrets (Windows):** API keys are read from environment variables (`%GEMINI_API_KEY%` and `%STITCH_API_KEY%`). Never write keys to disk.

## Session Startup Sequence
Read in order: `CLAUDE.md` -> `PLANNING.md` -> last 30 lines of `PROGRESS.md` -> `git status`. Resume the top `NOW` task.