# `t3-pilot` — Product & Architecture Blueprint

> **One-liner**: Turn expiring AI quota into morning surprises — without touching 1% of your fresh cycle. Smart task-to-model routing, a 20% emergency reserve shield, a coupled `7d × 5h` expiring-quota **Sparkle Queue**, and 1-click Skills/MCP sync built natively for **T3 Code**.

> [!TIP]
> **Blue-Ocean Verification**: `pingdotgg/t3code` has **74,240+ ⭐**, yet searching GitHub for third-party T3 Code quota/autopilot/sync tools returns **0 repositories**, and `npx t3-pilot` is **available** on npm.

---

## 1. Core Value Pillars

```mermaid
flowchart LR
    U["User & Sparkle Queue"] --> P["t3-pilot Engine"]
    T3["T3 Code (statev2.sqlite + limits.windows)"] --> P
    P --> R1["1. Smart Task × Quota Router"]
    P --> R2["2. 20% Emergency Reserve Shield"]
    P --> R3["3. Coupled 7d×5h Sparkle Harvester"]
    P --> R4["4. Cross-Harness Skills & MCP Sync"]
    R1 --> M1["Codex (gpt-6.2-sol)"]
    R1 --> M2["Antigravity Gemini (gemini-4-carbon / neon)"]
    R1 --> M3["Antigravity Claude (claude-opus-5-5 / sonnet-5-5)"]
```

### Pillar 1: Visual Pilot Cockpit (Inside T3 Preview + Chat Cards)
- Registers a top-bar **`Pilot`** project button in T3 Code (`scripts` integration) opening a live split-pane dashboard (works identically on macOS, Windows, remote `remote-linux` Linux, and T3 Mobile).
- Also renders inline interactive quota & routing cards via T3's `html_render` MCP tool.
- Displays unified **5-hour window %**, **7-day weekly %**, **Reset countdown (`resetAt`)**, and **Live Pace Curve** across `Codex`, `Antigravity (Gemini)`, and `Antigravity (Claude)` (with plug-and-play adapter stubs for native `claudeAgent` / `cursor` on community request).

### Pillar 2: Task-Fit × Surplus Smart Model Router + 20% Reserve Shield
- Classifies incoming tasks (`UI/Frontend & Long-form` $\rightarrow$ Claude Opus/Sonnet 5.5 or Gemini 4 Carbon/Neon; `Systems/Parsers/Tests/Debugging` $\rightarrow$ Codex `gpt-6.2-sol`; `Boilerplate/Docs/Translations` $\rightarrow$ `gemini-3.8-flash` / low effort).
- Multiplies **Task-Affinity Score $\times$ Burnable Surplus Above 20% Floor** weighted by proximity to `resetAt`.
- **20% Reserve Shield**: Once any pool reaches `<= 20%` weekly (or 5h) remaining, `t3-pilot` locks out automatic/delegated routing to that pool (switching idle threads between turns via `t3_thread_configure`, never interrupting mid-turn). Manual user overrides remain allowed for emergencies.

### Pillar 3: Coupled `7d × 5h` Expiring-Quota "Sparkle Engine" (垃圾额度造惊喜)
- **Sparkle Queue (`SPARKLES.md` + Cockpit UI + GitHub Issues)**: Drop daily brainstorms, wild "what-if" prototypes, or backlog sweeps:
  - **Repo Worktree Mode**: Runs in an isolated git worktree (`workspaceStrategy: "worktree"`) and opens a branch/PR—never touches `main`.
  - **Standalone Scratch Mode**: Auto-creates an isolated scratch workspace for pure research reports or interactive demos.
- **Coupled `7d × 5h` Harvest Law**:
  - Let weekly burnable surplus be $S_{\text{week}} = \max(0, R_{\text{week}} - 20\%)$, time to weekly reset be $T_{\text{left}}$, and single 5h window drain capacity be $C_{5\text{h}}$.
  - Early in the week, preserves 5h windows. Once $S_{\text{week}}$ approaches or exceeds $\lceil T_{\text{left}} / 5 \rceil \cdot C_{5\text{h}}$ (meaning you *cannot* spend the remaining weekly quota even at max 5h pace—e.g. 24h left with 80% weekly remaining), enters **Full-Throttle Harvest Mode** across every remaining 5h window.
  - Also harvests expiring idle 5h windows (`< 45m` to 5h reset) when weekly pace has surplus.
- **Two Absolute Hard-Stops**:
  1. **Zero-Fresh-Quota Guarantee (`resetAt` Epoch Lock)**: Stamps every run with `targetWindowResetAt`. At `resetAt - 2 min` (or the instant `resetAt` advances to the new cycle), **immediately halts** so **0.00% of refreshed quota is ever consumed**.
  2. **Human-First Instant Preemption**: Watches T3's `orchestration_v2_projection_runs` / `projection_threads`; the instant a human-initiated turn starts running, `t3-pilot` pauses/yields immediately so it never competes with active work, resuming only after configurable idle cooldown (default `15 min`).

### Pillar 4: 1-Click Cross-Harness Skills & MCP Sync
- Single source of truth (`.t3-pilot/skills/` & `.t3-pilot/mcp.json`) compiled & symlinked/synced cleanly across **Codex**, **Antigravity**, and **Claude Code** formats with diff preview and rollback.

---

## 2. Monorepo Layout (`t3-pilot` on `remote-linux`)

- `packages/core`: Quota window reader, Coupled `7d × 5h` math engine, Task-to-Model scorer, Human-activity detector, Skills/MCP transpiler (100% unit-tested).
- `packages/daemon`: Background governor + MCP server (`pilot_status`, `pilot_route`, `pilot_sparkle_add`, `pilot_sync`) + CLI (`npx t3-pilot init | status | up | sparkle | sync`).
- `apps/cockpit`: Lightweight zero-external-CDNs Vite + React dashboard rendered inside T3 Preview pane & exportable as a live GitHub Pages interactive demo for README visitors.

---

## 3. Multi-Model Build Plan on `remote-linux` (Enforcing 20% Weekly Floor)

| Milestone | Scope | Primary Model Assignment |
|---|---|---|
| **M1: Core Engine & Tests** | T3 SQLite/limits reader, Coupled `7d×5h` math, `resetAt` epoch lock, human preemption, Skills/MCP sync engine + Vitest suite | **Codex (`gpt-6.2-sol`)** |
| **M2: Daemon, CLI & T3 MCP Integration** | `npx t3-pilot` CLI, MCP server tools, T3 top-bar `Pilot` script installer, Worktree/Scratch Sparkle runner | **Codex (`gpt-6.2-sol`)** + **Gemini 4 Carbon** |
| **M3: Visual Cockpit & Chat Cards** | Split-pane T3 Cockpit UI (`apps/cockpit`), `html_render` inline quota/surprise cards, interactive GitHub Pages live demo | **Antigravity Claude (`claude-sonnet-5-5` / `opus-5-5`)** + **Gemini 4 Neon/Carbon** |
| **M4: Viral Launch Polish** | Animated terminal + Cockpit GIFs, bilingual EN/ZH README, Show HN / Reddit / T3 community launch kit, flip `AgoodNA/t3-pilot` Public | **Claude Opus 5.5 (via Antigravity)** + **Gemini 3.8 Flash** |
