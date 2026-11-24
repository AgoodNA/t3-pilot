# 🚀 t3-pilot Launch Kit

Copy-paste-ready launch drafts plus timing and checklist for the public launch of **`AgoodNA/t3-pilot`**.

> [!IMPORTANT]
> Every number in these drafts matches the shipped code: `0.85` full-throttle ratio, `C_5h = 14%`, `< 45m` expiring threshold, `resetAt − 2 min` epoch lock, `25 ms` WAL debounce, `15 min` cooldown, 20% floor, six Guarded Turbo rules, five MCP tools, port `4733`. If you change a default before launch, update the drafts too, because HN commenters *will* read `pacing-engine.ts`.

---

## 0. Pre-Launch Checklist

| # | Task | Owner | Done |
|---|---|---|:-:|
| 1 | `npm test` green on `main`; CI badge shows **passing** | Codex | ☐ |
| 2 | `deploy-cockpit-demo.yml` has published **https://agoodna.github.io/t3-pilot/?demo=1**; all 4 demo scenarios switch cleanly | Codex | ☐ |
| 3 | `npm publish` of `t3-pilot` (a human runs it; Guarded Turbo will `force_ask` an agent, as it should) | **Human** | ☐ |
| 4 | Fresh-machine smoke test: `npx t3-pilot init && npx t3-pilot up` on macOS, Windows and the Linux VPS; the **▶ Pilot** button appears in T3 Code | Human | ☐ |
| 5 | Export a `1280×640` PNG of `docs/assets/cockpit-hero.svg` → repo **Settings → Social preview** (GitHub won't take SVG) | Gemini 3.8 Flash | ☐ |
| 6 | Record a 20–30 s screen capture: click **Pilot** → Cockpit → start typing in T3 → Sparkle flips to `PREEMPTED` → cooldown. Export MP4 (X/Reddit) + GIF ≤ 10 MB (GitHub) | Human | ☐ |
| 7 | Repo topics: `t3code`, `ai-agents`, `claude`, `codex`, `gemini`, `mcp`, `quota`, `developer-tools`, `guardrails` | Human | ☐ |
| 8 | Flip `AgoodNA/t3-pilot` to **Public**, then pin it on your profile | Human | ☐ |
| 9 | Open 3–5 `good first issue`s (e.g. a native `cursor` adapter, a Cockpit i18n string table, more Guarded Turbo patterns) so newcomers have somewhere to start | Claude | ☐ |

### Launch-day timing

| Slot (all times local to audience) | Channel | Why |
|---|---|---|
| **Tue/Wed/Thu 08:00–09:30 PT** | Hacker News `Show HN` | Gets in front of the US morning while the front page is still turning over |
| HN + 1 h | X thread (tag `@t3dotgg`, quote the demo) | Rides the HN traffic, and T3 Code users are most active on X |
| HN + 2–3 h | `r/ClaudeAI`, then `r/ChatGPTCoding` 1 h later | Avoid cross-posting in the same minute, since mods treat that as spam |
| **Next day 09:30–11:00 CST (北京时间)** | V2EX `分享创造` → Linux.do → 即刻 | Chinese weekday-morning peak, with the HN result as social proof |
| Day 2 evening | 知乎专栏 long-form | Long-tail search traffic |

**Rule for the first 4 hours: reply to every comment within 15 minutes.** On HN, honest replies to critics count for more than upvotes.

---

## 1. Hacker News: `Show HN`

### Title (pick one, all < 80 chars)

```text
Show HN: T3-pilot – spend expiring AI coding quota, never the next cycle's
```
```text
Show HN: T3-pilot – an autopilot for AI coding quota with a 20% reserve floor
```
```text
Show HN: T3-pilot – harvest expiring Claude/Codex/Gemini quota, safely
```

**URL:** `https://github.com/AgoodNA/t3-pilot`. Link the repo, not the demo; HN prefers source.

### Maker's first comment (post immediately after submitting)

```text
Hi HN — I built t3-pilot because I pay for three AI coding plans (Codex, plus
Claude and Gemini through Antigravity) and use them all from T3 Code, and I kept
losing quota in two opposite ways: hoarding it all week and watching a chunk
expire at the weekly reset, or burning it early and hitting 0% mid-debug.

The interesting part is that the 5h and 7d windows are coupled nonlinearly.
The 5h window caps your *rate*, the 7d window caps your *total*. So late in the
week there's a point where even maxing every remaining 5h window can't spend
what's left. Waiting for "Sunday night" is already too late at that point.
t3-pilot computes this per pool, every tick:

  S_week = max(0, R_week − 20%)          # surplus above a hard 20% floor
  ratio  = S_week / (ceil(T_left/5h) × C_5h)

With C_5h ≈ 14% of weekly quota per maxed window, 24h left and 80% remaining
gives 60% / (5 × 14%) = 0.86. At ≥ 0.85 it goes full throttle on a queue of
ideas you wrote in a SPARKLES.md file. Each one runs in an isolated git worktree
(sparkle/<slug> branch → PR, never main) or a scratch folder. Earlier in the
week it only harvests the last <45 min of a 5h window that's about to expire
anyway, and only if weekly pace is on track.

Two hard stops I cared most about:

1. Epoch lock. Every run gets hardDeadlineAt = min(resetAt) − 2 min and halts
   there (or immediately if resetAt advances). The goal is that 0.00% of a fresh
   cycle is ever spent. The 2 min margin is a floor in code, not a default.

2. Human-first preemption without patching T3 Code. T3 keeps its state in
   SQLite with WAL. I open it strictly read-only (file:…?mode=ro) and fs.watch
   the db/-wal/-journal files with a 25 ms debounce. When a non-pilot human turn
   appears in T3's projection tables, the pilot run is interrupted through the
   official t3 CLI/MCP, and it waits for 15 min of idle before resuming. Every
   mutation goes through T3's own tools. I never write to its database.

The other piece is "Guarded Turbo", which sits between Auto (prompts on every
npm test, so overnight runs stall) and Full Access (will happily cat ~/.ssh).
It's one policy file, .t3-pilot/shield.json, with 6 red-line rules (destructive
deletes, host credentials + cloud metadata, force-push to protected branches,
host firewall/foreign containers → deny; package publish, repo visibility/
secrets → ask). It compiles to:

  - Antigravity: .agents/hooks.json PreToolUse → allow | deny | force_ask
  - Claude Code: .claude/settings.json PreToolUse → permissionDecision
  - Codex:       .codex/rules/*.rules prefix_rule(decision = forbidden|prompt)

plus a generated SKILL.md, so the agent knows the rules before it tries. The hook
actually tokenizes shell (splits && ; |, unwraps sudo/env/bash -c, recurses
into $(…), normalizes ~/$HOME/..) and fails closed: unparseable payload = deny.

Honest limitations: Codex rules are prefix-based, so regex/path checks there rely
on the skill plus `t3-pilot shield check`. Quota numbers are only as fresh as T3's
cache (stale > 60 min = no harvesting). It's built for T3 Code specifically.

Offline demo (no install): https://agoodna.github.io/t3-pilot/?demo=1
Try it: npx t3-pilot init && npx t3-pilot up

TypeScript, Node ≥ 22.5, MIT, 200+ Vitest tests. I'd love feedback on the pacing
math, especially from anyone whose provider meters differently.
```

### Prepared replies (paste-adapt; don't copy verbatim twice)

| They say | You say |
|---|---|
| "Isn't this gaming the provider?" | It only spends quota you already paid for, inside the limits the provider sets, through the official T3 tools. It never goes over a limit. It actually leaves 20% untouched and stops 2 min early. |
| "Why not just use Full Access in a container?" | Containers are great and you should use them. Guarded Turbo covers the case where the agent runs on your real dev box with your real git remote: force-push to `main` and `~/.aws` reads are still one tool call away inside a mounted workspace. |
| "25 ms is marketing." | It's the debounce on `fs.watch` of `statev2.sqlite-wal` (see `governor.ts`). The interrupt goes out after that through `t3_thread_interrupt`, and the docs don't claim the provider stops in 25 ms. |
| "Why 0.85 and not 1.0?" | At 1.0 you need every remaining window maxed perfectly, and real sessions aren't. 0.85 leaves headroom for idle hours and for your own human turns. It's configurable (`fullThrottleRatioThreshold`). |

---

## 2. Reddit

> [!WARNING]
> Read each sub's self-promo rules first. Use a text post (not a bare link), say up front that you built it, and stay in the thread to answer questions.

### 2a. `r/ClaudeAI`

**Title:** `I built a seatbelt for unattended Claude runs: one policy → PreToolUse hooks across Claude Code, Antigravity & Codex (+ it spends expiring quota on your backlog)`

**Flair:** `Built with Claude` / `Productivity`

```markdown
**TL;DR:** `npx t3-pilot init && npx t3-pilot up`. Open-source (MIT) autopilot for
T3 Code that (1) spends quota that's about to expire on a queue of ideas, in git worktrees
that open PRs and never touch `main`, and (2) compiles one safety policy into native
`PreToolUse` hooks for Claude Code, Antigravity and Codex. Built mostly *with* Claude Opus/Sonnet.

**The problem I had**

I run Claude (via Antigravity), Codex and Gemini side-by-side in T3 Code. Every week:

- Either I saved Claude quota "just in case" and a big chunk expired unused at the weekly reset,
- or I went hard early and hit 0% in the middle of a debugging session.
- And whenever I wanted something to run overnight, I had to pick between **Auto**
  (it stalls on the first "Allow `npm test`?" prompt) and **Full Access** (it will happily run
  `cat ~/.ssh/id_ed25519` or `git push --force origin main` if the model gets confused).

**What t3-pilot does about it**

🧮 **Coupled 7d × 5h harvest math.** Late in the week there's a point where even maxing
every remaining 5h window can't spend what's left of the weekly quota. It checks that
every tick: `surplus / (ceil(hours_left / 5) × 14%) ≥ 0.85` → full throttle. Example:
24h left with 80% remaining → 60% / 70% = 0.86 → go.

✨ **Sparkle Queue.** A `SPARKLES.md` checklist. `[worktree]` items run on a
`sparkle/<slug>` branch and open a PR; `[scratch]` items get their own folder. In the
morning you have a few PRs to review that were paid for with quota you'd have lost anyway.

🛑 **Two hard stops.** Halts at `resetAt − 2 min`, so 0.00% of the new cycle is used.
And it yields within ~25 ms the moment *you* start a turn in T3 (it watches T3's
SQLite WAL read-only, no patches), then waits 15 min of idle before resuming.

🛡️ **Guarded Turbo.** 6 rules (destructive deletes, `~/.ssh`/`~/.aws`/cloud metadata,
force-push to protected branches, host firewall/foreign containers → **deny**;
`npm publish`, repo visibility/secrets → **ask**). One `.t3-pilot/shield.json` compiles to:

- Claude Code → `.claude/settings.json` `PreToolUse` with `permissionDecision: deny|ask|allow`
- Antigravity → `.agents/hooks.json`
- Codex → `.codex/rules/t3-pilot-guarded-turbo.rules`

…plus a generated `guarded-turbo/SKILL.md`, so Claude knows the red lines *before* it
tries. The hook really parses shell (`&&` chains, `sudo`, `bash -c`, `$(…)`, `~` and `..`)
and **fails closed**.

🧯 **20% reserve floor.** A pool at ≤ 20% gets locked out of automatic routing, so
there's always something left for an emergency.

**Try it without installing:** https://agoodna.github.io/t3-pilot/?demo=1 (offline sim, 4 scenarios)
**Repo:** https://github.com/AgoodNA/t3-pilot

Happy to answer anything about the hook format, the pacing math, or how it reads T3 without touching its DB.
```

### 2b. `r/ChatGPTCoding`

**Title:** `Stop losing your Sunday-night Codex quota: an open-source scheduler that turns expiring quota into overnight PRs (with hard stops so it never touches the next cycle)`

```markdown
I use Codex (`gpt-6.2-sol`) for systems work alongside Claude and Gemini in T3 Code.
I got tired of the weekly reset wiping out quota I'd been saving, so I built
**t3-pilot** (MIT): `npx t3-pilot init && npx t3-pilot up`.

**How a typical week goes with it**

- **Mon–Wed: `PRESERVE_WINDOWS`.** It does nothing. Your quota is yours.
- **Mid-week: `EXPIRING_5H_HARVEST`.** If a 5h window has < 45 min left *and*
  your weekly pace is on track, it spends just that tail, which would have expired anyway.
- **Last ~24h: `FULL_THROTTLE_HARVEST`.** Once
  `weekly_surplus / (remaining_5h_windows × 14%) ≥ 0.85`, you couldn't spend it all
  even at max pace, so every window goes to your queue.
- **`resetAt − 2 min`: hard stop.** 0.00% of the new cycle is touched, and that 2-minute
  margin can't be configured lower.

**What it actually runs:** items from `SPARKLES.md`. `[worktree]` items get a fresh git
worktree on `sparkle/<slug>` and end as a PR, never on `main`. Good fits: flaky-test sweeps,
dependency audits, perf investigations, "try this refactor and show me the diff".

**It gets out of your way.** It watches T3's SQLite WAL (read-only) and interrupts its own
run within ~25 ms of you starting a turn, then waits 15 min of idle before it comes back.

**Smart routing:** `score = TaskAffinity × SurplusFactor × UrgencyWeight`. Parser/test/debug
tasks go to Codex, UI/long-form goes to Claude/Gemini, and boilerplate/i18n goes to
`gemini-3.8-flash`. Any pool at ≤ 20% is locked out so you keep an emergency reserve.

**Safe unattended runs:** "Guarded Turbo" compiles one policy to Codex
`.codex/rules/*.rules` (`prefix_rule` → `forbidden`/`prompt`), Claude Code hooks and
Antigravity hooks. `rm -rf /`, `~/.ssh`, `git push -f origin main` → denied. `npm publish` → asks.
`npm test` → just runs.

Offline demo: https://agoodna.github.io/t3-pilot/?demo=1 · Repo: https://github.com/AgoodNA/t3-pilot

Feedback on the pacing constants (14% per 5h window, 0.85 threshold) is very welcome,
especially if your plan meters differently.
```

---

## 3. X / Twitter Thread

Tag `@t3dotgg` on post 1 only. Pin the thread. Attach the listed visual to **every** post; threads with images get far more engagement.

**1/5** · 🖼️ `cockpit-hero` (PNG export) or the 25 s screen capture
```text
I kept losing ~half my weekly AI quota at reset, or hitting 0% on Thursday.

So I built t3-pilot: an autopilot for @t3dotgg's T3 Code that spends *expiring* Codex/Claude/Gemini quota on your backlog, and never touches the next cycle.

npx t3-pilot init && npx t3-pilot up

🧵
```

**2/5** · 🖼️ `coupled-harvest-law`
```text
The 5h and 7d windows are coupled.

5h caps your rate, 7d caps your total. Late in the week, maxing every remaining 5h window can't spend what's left.

surplus / (⌈hours_left/5⌉ × 14%) ≥ 0.85 → full throttle

24h left, 80% left → 60/70 = 0.86 → go.
```

**3/5** · 🎬 screen capture of typing in T3 → Sparkle flips to `PREEMPTED`
```text
Two hard stops:

⏱ resetAt − 2 min epoch lock → 0.00% of a fresh cycle spent
🧍 You type in T3 → pilot yields in ~25 ms (read-only watch on T3's SQLite WAL, zero patches), resumes after 15 min idle

Work lands in git worktrees as PRs. Never on main.
```

**4/5** · 🖼️ `guarded-turbo-architecture`
```text
"Auto" stalls overnight on "Allow npm test?"
"Full Access" will cat ~/.ssh if the model gets confused.

Guarded Turbo: one policy → native PreToolUse hooks for Antigravity, Claude Code and Codex + a SKILL.md.

rm -rf / → deny
npm publish → ask
npm test → runs

Fails closed.
```

**5/5** · 🖼️ Cockpit `03 Shield & Sync` view, or the demo URL card
```text
Also: 20% emergency reserve floor, Task-Fit × Surplus model router, 1-click Skills/MCP/hooks sync with diff + rollback.

Try the cockpit offline, no install:
agoodna.github.io/t3-pilot/?demo=1

MIT · TypeScript · 200+ tests
github.com/AgoodNA/t3-pilot
```

---

## 4. 中文技术社区首发草稿

> [!TIP]
> 中文社区很反感营销腔。语气就像跟同行聊天：先讲自己踩的坑，再讲怎么解决，最后坦白局限。别堆 emoji，别写"颠覆""革命性"。

### 4a. V2EX · `分享创造`

**标题：** `[开源] t3-pilot：把快过期的 AI 编程额度拿去跑 backlog，到点前 2 分钟自动刹车，一分新额度都不碰`

```markdown
各位好，分享一个自己做的小工具，MIT 开源。

**背景**

我平时在 T3 Code 里同时用 Codex、Antigravity 的 Claude 和 Gemini 三家。每家都有 5 小时窗口 + 7 天窗口两套计量，结果每周不是这样就是那样：

- 舍不得用，周日晚上一重置，一大截额度白白蒸发；
- 周二用猛了，周四 debug 到一半额度归零；
- 想让它通宵跑点活，要么开 Auto，第一个"Allow npm test?"弹窗就卡住；要么开 Full Access，又怕它哪天脑子一抽 `rm -rf` 或者去读 `~/.ssh`。

**t3-pilot 做了什么**

1. **7d × 5h 耦合收割。** 5h 窗口限制花得多快，7d 窗口限制总共能花多少。到了周末，剩下的 5h 窗口数可能已经不够把周额度花完。每次 tick 都会算一遍：
   `S_week = max(0, 周剩余 − 20%)`，`ratio = S_week / (⌈剩余小时/5⌉ × 14%)`，`ratio ≥ 0.85` 就全速收割。比如还剩 24 小时、周额度剩 80%：60% / 70% = 0.86，开跑。周中只在某个 5h 窗口剩不到 45 分钟、而且周节奏不落后时，才把这点尾巴用掉。

2. **Sparkle 队列。** 在 `SPARKLES.md` 里写待办，`[worktree]` 会在 `sparkle/<slug>` 分支的独立 worktree 里跑，最后提 PR，不碰 main；`[scratch]` 在单独目录里跑调研或原型。第二天早上起来 review PR 就行。

3. **两道硬停。**
   - 每个任务带 `hardDeadlineAt = min(resetAt) − 2 分钟`，到点就停，`resetAt` 中途推进也立即停。新周期额度消耗 0.00%，这 2 分钟边际在代码里是下限，配置不能调低。
   - 真人优先：只读打开 T3 的 `statev2.sqlite?mode=ro`，`fs.watch` 监听 WAL 文件（25ms 去抖）。你一开始在 T3 里打字，pilot 任务就通过官方 `t3` CLI / MCP 被打断，空闲满 15 分钟才恢复。全程不改 T3 一行代码，也不写它的数据库。

4. **Guarded Turbo 安全带。** 一份 `.t3-pilot/shield.json`，6 条红线规则（毁灭性删除、主机凭证与云元数据、强推保护分支、动宿主防火墙或别人的容器 → 直接拒绝；发包、改仓库可见性或 secrets → 必须人工确认），一键编译成三家的原生格式：
   - Antigravity：`.agents/hooks.json`（`PreToolUse` → allow / deny / force_ask）
   - Claude Code：`.claude/settings.json`（`permissionDecision`）
   - Codex：`.codex/rules/t3-pilot-guarded-turbo.rules`（`prefix_rule` → forbidden / prompt）

   另外再生成一份 `SKILL.md` 做软约束。Hook 会真正解析 shell（拆 `&&`/`;`/`|`，剥 `sudo`/`env`/`bash -c`，递归 `$(…)`，归一化 `~`/`..`），解析失败一律 deny。

5. **20% 保底 + 智能路由。** 任何池 ≤ 20% 就锁住，不再自动派活；路由按 `任务契合度 × 可燃余量 × 临期紧迫度` 打分，解析器/测试类给 Codex，UI/长文给 Claude/Gemini，翻译/样板给 Flash。

**上手**

    npx t3-pilot init
    npx t3-pilot up

`init` 会在 T3 Code 顶栏加一个 ▶ Pilot 按钮，点开就是驾驶舱。不想装可以先玩离线演示：https://agoodna.github.io/t3-pilot/?demo=1

**已知局限**

- Codex 的 rules 只支持前缀匹配，路径/正则类检查在 Codex 那边靠 Skill + `t3-pilot shield check` 兜底；
- 额度数据取决于 T3 的缓存，超过 60 分钟没刷新就不收割；
- 目前只针对 T3 Code。

仓库：https://github.com/AgoodNA/t3-pilot
欢迎拍砖，尤其是节奏公式那块（14%/窗口、0.85 阈值），不同套餐的计量方式可能不一样，很想听听大家的数据。
```

### 4b. Linux.do

**标题：** `开源了一个 T3 Code 额度自动驾驶：临期额度跑 PR + 跨 Claude Code / Codex / Antigravity 的 PreToolUse 安全带`

```markdown
佬友们好，最近搓了个 T3 Code 的小工具，开源出来给大家玩玩。

**一句话：** 自动算出哪些 AI 额度马上要过期、而且花了也不影响你，用这部分额度在独立 worktree 里跑你排好的任务，最后提 PR；重置前 2 分钟刹车，你一打字它就让路。

几个我自己比较满意的点：

- **不改 T3、不写它的库**：`statev2.sqlite` 只读打开（`?mode=ro`），监听 WAL 文件，25ms 内感知你开始干活，然后通过官方 `t3` CLI 打断自己的任务，冷却 15 分钟才回来。
- **一份策略管三家**：`rm -rf /`、读 `~/.ssh`、`git push -f origin main` 直接拒；`npm publish`、`gh repo edit --visibility` 必须问人；`npm test` 直接放行。分别编译成 Antigravity 的 `.agents/hooks.json`、Claude Code 的 `.claude/settings.json`、Codex 的 `.rules` 文件。Hook 失败即拒绝。
- **20% 保底**：任何池掉到 20% 以下，自动路由就不碰它，留给你半夜救火。
- **一键三端同步**：Skills / MCP / Hooks 以 `.t3-pilot/` 为唯一来源，先看 diff 再 apply，随时 rollback。

上手两行：`npx t3-pilot init && npx t3-pilot up`
离线演示：https://agoodna.github.io/t3-pilot/?demo=1
GitHub：https://github.com/AgoodNA/t3-pilot

有 bug 或者想要的 adapter（比如原生 Cursor）直接开 issue，佬友们的 PR 优先合 🙏
```

### 4c. 即刻

```text
周日晚上看着 AI 额度清零，心疼了好几周，干脆写了个工具😂

t3-pilot：T3 Code 的额度自动驾驶
· 快过期的额度 → 自动在 git worktree 里跑你的 backlog，早上起来 review PR
· 重置前 2 分钟刹车，新周期额度 0.00% 不碰
· 你一打字它 25ms 内让路
· 一份安全策略编译到 Claude Code / Codex / Antigravity 三家 hook，rm -rf 和读 ~/.ssh 直接拒

npx t3-pilot init && npx t3-pilot up
离线试玩 👉 agoodna.github.io/t3-pilot/?demo=1
```

### 4d. 知乎专栏 · 导语

**标题：** `每周白白浪费的 AI 编程额度，我用一个公式把它们变成了 PR`

```markdown
如果你同时订阅了好几家 AI 编程服务，大概率遇到过这种尴尬：周一舍不得用，周日晚上眼睁睁看着额度清零；或者周二火力全开，周四卡在 debug 中途。

问题的根源在于，5 小时窗口和 7 天窗口不是两个独立的限制，而是**耦合**的：前者决定你花得多快，后者决定你总共能花多少。到了周末，剩下的 5 小时窗口数可能已经**不够**花完周额度，哪怕每个窗口都跑满。真到那一步再想花，已经来不及了。

这篇文章会讲清楚三件事：

1. 怎么用 `ratio = S_week / (⌈T_left/5⌉ × C_5h)` 精确判断这个临界点，以及为什么阈值是 0.85 而不是 1.0；
2. 怎么在**不修改 T3 Code、只读其 SQLite** 的前提下，做到真人一开口、自动任务 25ms 内让路，并且在重置前 2 分钟硬停，保证新周期额度 0.00% 不被消耗；
3. 怎么把一份安全策略同时编译成 Claude Code、Codex、Antigravity 三家的 `PreToolUse` Hook，让无人值守的 Agent 既不用每条命令都弹窗确认，也不会去碰你的 `~/.ssh`。

所有代码都已开源在 [t3-pilot](https://github.com/AgoodNA/t3-pilot)（MIT），可以先去 [离线演示](https://agoodna.github.io/t3-pilot/?demo=1) 里切换"周初巡航""临期收割""最后 24 小时全速""保底锁定"四个场景，直观感受一下。
```

---

## 5. Visual Asset Map

| Asset | Size | Use it in |
|---|---|---|
| [`docs/assets/cockpit-hero.svg`](./docs/assets/cockpit-hero.svg) | 1200×680 | README hero · X 1/5 · social preview (export PNG 1280×640) · V2EX/Linux.do header |
| [`docs/assets/coupled-harvest-law.svg`](./docs/assets/coupled-harvest-law.svg) | 1100×400 | README feature 1 · X 2/5 · HN replies about the math · 知乎正文配图 |
| [`docs/assets/guarded-turbo-architecture.svg`](./docs/assets/guarded-turbo-architecture.svg) | 1100×360 | README feature 2 · X 4/5 · r/ClaudeAI post |
| Screen capture (to record) | 20–30 s | X 1/5 or 3/5 · Reddit · README (GIF) |

X, Reddit, V2EX and 即刻 don't render SVG uploads, so export each asset to PNG at 2× (e.g. `rsvg-convert -z 2 in.svg -o out.png`, or a headless browser screenshot) before posting.

## 6. Post-Launch (Day 1–7)

- [ ] Reply to every HN/Reddit/V2EX comment in the first 4 hours, and turn real bugs into issues while the thread is still live.
- [ ] Day 2: post a "launch numbers + what I learned" update on X, quoting the original thread.
- [ ] Day 3: write a `CHANGELOG.md` entry for anything fixed from feedback, then cut `v0.1.1`.
- [ ] Day 7: write a retro covering stars, npm downloads, demo visits (Pages analytics), and top requested adapters → plan M5.
