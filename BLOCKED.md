# BLOCKED.md
**File:** `BLOCKED.md`

## Active Blockers

### [2026-08-24] Nano Banana MCP server not attached to current session
- **What:** `.mcp.json` now registers the `nano-banana` MCP server (`@rafarafarafa/nano-banana-pro-mcp` via `npx.cmd`), but MCP registrations only load at session start. The current session has Stitch (verified responding) but no Nano Banana tools.
- **Impact:** Low for now — Nano Banana (Gemini Image) is only needed for design-asset generation in the Stitch/design pipeline, not for core feature work.
- **Unblock:** Restart the Claude Code session in this workspace so `.mcp.json` is loaded, then approve the server when prompted.

## Resolved
- **[2026-08-24] Environment variables:** `GEMINI_API_KEY` and `STITCH_API_KEY` both verified present (values never echoed). Node v24.14.0, npm 11.9.0, PHP 8.5.3 all available on PATH.