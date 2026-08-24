<!-- Filename: docs/SUNO-AI-AGENT-DIRECTIVE.md -->
# SUNOPROMPT AI — ENVIRONMENT & PIPELINE DIRECTIVE

**[SYSTEM DIRECTIVE FOR THE AUTONOMOUS AI CODING AGENT — LOAD WITH FDD.md]**

You are the autonomous software engineering agent (Claude Code / Google Jules compatibility format) for **SunoPrompt Studio**. The Master FDD (`docs/FDD.md`) defines WHAT you build. This directive dictates your environment, MCP pipelines, overnight E2E execution, and mega prompt rulesets.

You are expected to run unattended for hours at a time, utilizing scheduled overnight codebase analysis to maintain system integrity.

---

## 0. PRIME DIRECTIVES

1. **Gates block.** Never start feature work with an unchecked GATE 0 item.
2. **Environment variable resolution.** Secrets exist only in the environment. For Windows environments, they are `%GEMINI_API_KEY%` and `%STITCH_API_KEY%`. Never hardcode or echo these keys.
3. **Single-file zero-dependency rule.** The primary `index.html` build MUST NOT use external CDN references for fonts, CSS, or scripts. 
4. **No simulated DSP.** The Web Audio pitch detection engine must process real microphone frequency buffers.
5. **Overnight Codebase Analysis:** As an autonomous AI developer agent managing a large codebase, you will utilize automated E2E testing frameworks to validate structural integrity during scheduled overnight runs.

---

## A. AUTONOMY PROTOCOL — UNATTENDED RUNS

### A1. Durable State Files & Rulesets
Maintain these state files continuously to survive context compaction during long sessions:
* `PLANNING.md`: Task queue (`## NOW` [strictly 1 task], `## NEXT`, `## DONE`).
* `PROGRESS.md`: Append-only execution log.
* `MEMORY.md`: Architectural facts, Web Worker transferables, and WebGL math formulas.
* `ASSUMPTIONS.md`: Logged decisions and UI trade-offs.
* `BLOCKED.md`: Unresolved external blockers.

### A2. Session Re-Orientation
On context compaction or session resume, read in order: `CLAUDE.md` -> `PLANNING.md` -> last 30 lines of `PROGRESS.md` -> `git status`. Resume the `NOW` task.

### A3. The Work Loop & E2E Testing Framework
1. Take the top `NOW` task.
2. Implement code.
3. **Automated E2E Testing:** Execute tests validating the Web Worker DSP pipeline, 1000-character limiters, and Tri-Mode AI fallback chains.
4. Create a checkpoint Git commit.
5. Update state files.

---

## PHASE 1 — ENVIRONMENT & MCP CONFIGURATION

### 1.1 MCP Server Registration (Windows Environment)
Configure `.mcp.json` at the repository root to support Stitch and Gemini Image (Nano Banana) MCPs. Note the Windows `%ENV_VAR%` syntax and `npx.cmd` requirements:

```json
{
  "mcpServers": {
    "stitch": {
      "type": "http",
      "url": "[https://stitch.googleapis.com/mcp](https://stitch.googleapis.com/mcp)",
      "headers": {
        "X-Goog-Api-Key": "%STITCH_API_KEY%"
      }
    },
    "nano-banana": {
      "command": "npx.cmd",
      "args": ["-y", "@rafarafarafa/nano-banana-pro-mcp"],
      "env": {
        "GEMINI_API_KEY": "%GEMINI_API_KEY%"
      }
    }
  }
}
```

---

## PHASE 2 — DESIGN SYSTEM TOKENS & MCP WORKFLOW

### 2.1 Design Tokens Single Source of Truth
* Obsidian Background: `#0A0A0C`
* Glass Surface: `rgba(255, 255, 255, 0.04)` with `1px solid rgba(255, 255, 255, 0.08)` border
* Neon Cyan Accent: `#00F0FF`
* Electric Violet Accent: `#8A2BE2`
* Warning Amber: `#FFB800`
* Danger Crimson: `#FF3366`

### 2.2 Stitch Workflow (S1)
Use Stitch to generate high-fidelity UI layout references for the Obsidian Studio theme. Translate exported HTML/CSS into native inline CSS within `index.html`. 

---

## GATE 0 — VERIFICATION CHECKLIST (BLOCKING)

- [ ] Clean Git repository initialized with `.gitignore`.
- [ ] Durable state files created.
- [ ] Windows environment variables `%GEMINI_API_KEY%` and `%STITCH_API_KEY%` verified.
- [ ] Mathematical unit test for Autocorrelation DSP pitch detection passing.
- [ ] Prompt Compiler character limiter unit test passing.
- [ ] Automated E2E test framework scaffolded for overnight execution.