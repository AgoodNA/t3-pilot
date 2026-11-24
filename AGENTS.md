# AGENTS.md — t3-pilot Engineering & Quota Rules

1. **Quota Floor Rule**: Always respect the user's 20% weekly quota reserve floor across all providers (`codex`, `antigravity` Gemini pool, `antigravity` Claude pool). Advance milestone-by-milestone (`M1 -> M2 -> M3 -> M4`), never run unbounded loops.
2. **Provider Pool across providers**:
   - **Codex (`gpt-6.2-sol` / `gpt-6.1-terra`)**: Core TypeScript state/math engines, SQLite/RPC adapters, CLI/daemon concurrency, and strict unit/integration tests.
   - **Antigravity (`claude-opus-5-5`, `claude-sonnet-5-5`, `gemini-4-carbon`, `gemini-4-neon`)**: Architecture orchestration, Cockpit UI/UX (`apps/cockpit`), `html_render` cards, and launch documentation.
   - **Antigravity (`gemini-3.8-flash`)**: Fixtures, translations, and lightweight checks.
   - **Do NOT install or authenticate standalone `claudeAgent` CLI on this VPS** (protects direct Anthropic account from datacenter IP flags; use `antigravity` Claude models instead, while keeping clean adapter interfaces for community users who use `claudeAgent` locally).
3. **Architecture & Safety**:
   - Read T3's `statev2.sqlite` strictly in read-only mode (`?mode=ro`) and mutate threads/projects only through official `t3` CLI / T3 MCP tools.
   - Enforce the two hard-stops on Sparkle runs: (a) `resetAt` epoch lock (`stop >= 2 min` before reset and never cross into a new quota cycle), and (b) instant preemption whenever any non-pilot human turn becomes active.
