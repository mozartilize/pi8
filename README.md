# pi8: automatic model router for Pi

pi8 is an extension for [Pi](https://github.com/earendil-works/pi-coding-agent). It routes each turn and each [pi-subagents](https://www.npmjs.com/package/pi-subagents) role to a model from your authenticated providers.

## Why

With several authenticated providers, you usually select a model by hand for each session and each subagent role. You make that choice without data. Public benchmarks measure intelligence, coding, price, and speed. pi8 fetches these benchmarks and matches them to Pi's model registry. Then it routes every turn to the model with the best cost/quality match.

## Disclaimer

**Heavy AI assistance** went into this extension. Use it at your own risk.

## Install

```json
// ~/.pi/agent/settings.json or .pi/settings.json
{
  "packages": ["git:github.com/mozartilize/pi8"]
}
```

For local development, load a checkout through `.pi/extensions/` or with `pi -e /path/to/index.ts`.

## Quick start

1. Install Chromium for the `playwright-core` version in the pi8 package. From the package directory, run:
   ```sh
   npx playwright-core install --no-shell chromium
   ```
   On Linux, add `--with-deps` if Chromium cannot start because system libraries are missing. This needs sudo.
2. Create a free API key at [artificialanalysis.ai](https://artificialanalysis.ai/).
3. Run `/router-sync <your-key>`.
4. Set the session model to `router/auto`.

When Chromium is missing, selecting `router/auto` shows an install command for the exact resolved package version. Automatic turns stop with that setup message and make no model call. Install the browser and run `/router-sync`; Pi does not need a restart. Concrete-model sessions are unaffected.

Sync reads both the API and the public models page. If either fails, it keeps the previous store. Without a synced store, Chromium-ready routing can use registry metadata, but quality is unknown.

## How it works

```
/router-sync → benchmark data
                    ↓
   collect context → hand_off_context → task type
                    ↓
         pick best (model, effort) → fallback chain
                    ↓
             delegate with automatic retry
                    ↓
     plan/review done → commit_execution(plan + rubric)
                    ↓
     router sets executor minimum ──→ plan broken → back to planner
                    ↓                   (2nd strike by a model → stronger executor)
     executor edits every listed file
                    ↓
     planner reviews ──→ new plan → rework (a strike)
```

For each turn, the router does these steps:

1. **Collect context.** A new request without a serving model starts as `gather`: the model may only read, ask you a question, or call `hand_off_context`. A ready handoff declares the task type, how complex the work is, and its scope, and names the work item it belongs to. A direct answer needs no handoff. Later requests stay with the serving model at its task type until it hands off again.
2. **Score.** The router scores every available model against live benchmarks and registry metadata: quality, cost, speed, and context window. A model below a capability minimum stays behind measured suitable and unknown models in the fallback chain. Price and cache credit cannot move it across those tiers.
3. **Stream.** The router streams the reply from the top pick. If that model fails before any output, the router moves to the next model in the chain. Failures include missing credentials, a timeout, and a provider error. After an answer or a tool call starts to stream, the router never replays the turn.
4. **Hand off.** When a `plan` or `review` turn has settled every decision, the model can call `commit_execution` with the remaining file changes and checks, and rate the remaining work from 1 to 5 on five criteria: open decisions, spread, verification, knowledge needed, and coupling. The router, not the model, turns the ratings into the minimum quality an executor needs. It also measures the plan itself: the number of files and folders, the size of the files, and how often recent commits fixed them. A plan with more than 2 files or 4 steps needs at least a `standard`-band executor; one with more than 5 files or 8 steps, open design decisions, or a missing file stays with the current model.
   - If the executor edits a file outside the plan, writes files from a shell command, re-plans, or struggles, the next step returns to the planning model.
   - When the executor has edited every listed file, the planning model takes over as a reviewer until the end of your message, so checks listed after the last edit run during that review. If it submits a new plan instead, that counts against the executor.
   - A model that breaks or needs rework on two plans in one task is replaced by a strictly stronger model one band higher.
   - If the model edits before submitting a plan, the router appends one reminder to that edit's result.
   - `/router-why` shows the plan on its `plan:` line. The decision log records each plan's ratings, measurements, and outcome, so the weights can be fitted to real results later.
5. **Route subagents.** At spawn time, the router scores each visible structured child. It uses the role's minimum task type, the task, scoring weights, and how full the context is. Explicit child models and user or project pins always win. For children inside a `workflowScript` string, the router sets only the tool's default model. See [`ARCHITECTURE.md`](ARCHITECTURE.md#4-subagent-routing) for the details.

Uncertainty always routes up. Missing data or a missing declaration never makes routing cheaper.

pi8 has no effect on a session that uses a concrete model instead of `router/auto`.

### Capability and model preferences

Fixed minimums do not change when the request's candidate pool changes:

| Task type | Minimums for the preferred tier |
|---|---|
| `lightweight` | none |
| `gather` | intelligence ≥ 20 |
| `plan`, `review` | intelligence ≥ 30, Omniscience ≥ 0, Briefcase rubric pass rate ≥ 0.35 |
| `implement` | agentic coding ≥ 30 |

Omniscience measures closed-book correctness: zero means correct answers balance incorrect answers. Briefcase measures work from source files against deliverable checks. Both are required for plan/review. Hallucination rate is not a separate minimum. Missing measurements rank ahead of measured weak values, behind models that meet all minimums. A measured failure on one axis is not erased by a missing value on another.

Accepted handoffs use their rubric and band requirement against fixed reference strengths, rather than a request-local maximum. Long requests (≥ 64,000 tokens) also need LCR ≥ 0.30; image requests need MMMU-Pro ≥ 0.30. Missing values remain unknown. Speed uses time per task when the preferred tier has complete coverage; otherwise it uses output tokens per second.

Every recently served candidate can get prompt-cache credit, priced from its own registry cache rates and capped by `switchMargin`. After the two-week collection period, cross-session credit additionally requires an identical system prompt and tool schema at the same provider, model and effort; it expires after one hour. Selection counts earn no points.

`model-events.jsonl` collects protocol counts across sessions. Penalties are **off until two weeks of data have been collected and `reputationWeights` has been configured**. Fit the weights from those observations. They need at least 30 decayed entries for reminder rate or 10 completed reminder episodes for ignore rate. Counts have a 30-day half-life. Penalties cannot cross capability tiers or remove fallbacks. `/router-status` shows the counts and `/router-why` explains a penalty that changed preference. Set `reputation: false` to disable collection, cross-session credit and penalties. Execution outcome bonuses are not enabled.

### Completing and returning to work

In `router/auto`, the serving model calls `complete_work` when the user's request is complete, in any task type. Its own suggestions, optional next steps, and offers to do more do not keep the work open. An unfinished request, a required answer from the user, or an unfixed failed test/build does.

Completion closes the current work item but keeps the model and conversation. That model also serves the next entry:

  - A question about completed work can be answered directly, without reopening it.
  - More changes to that same work item need `reopen_work`; `hand_off_context` refuses that item. The router records a `reopen` and can repick the serving model once.
  - Different work needs `hand_off_context` to its own work item or a new one.

Until the handoff, the mutation gate blocks file changes, execution plans, and subagent calls. It uses the router's best-effort mutation detector, not a shell sandbox. Superseded work stays terminal. The work-choice catalog and reminders are added only to delegated requests, not the system prompt or Pi transcript. Answers stream without a retry just because a handoff declaration is missing.

Before a run ends, the router can add one hidden reminder and continue once. It reminds the model to call `hand_off_context` if collecting context ends without one and the request is not a `gather` or `lightweight` question, or the router refused a handoff or a call. It reminds the model to call `complete_work` if the entry ran its plan, changed files, or delivered the plan or review it was handed, and did not complete the work. If the model still does not call the tool, the context stays unresolved and the work stays open.

## Commands

| Command | Purpose |
|---|---|
| `/router-sync [key]` | Fetch new benchmark data |
| `/router-status` | Show data freshness, coverage, pin state, and the last decision |
| `/router-report` | Show routed spend against baseline spend, the percent saved, and turns by task type for this session |
| `/router-manual [provider/model[:thinking]\|resume]` | Pin one model for this session. Space shows searchable model completions. Enter opens Pi's `/model` picker. |
| `/router-semi [on\|off]` | Ask before the router switches away from the last served model. Saves `semi` in the config. |
| `/router-why` | Explain why the router chose the last model |
| `/router-models` | Show the allowlist and the models that match it |
| `/router-agents` | Show the model that each subagent role resolves to |
| `/router-fix <slug> <id>` | Override a benchmark-to-registry mapping |
| `/router-blacklist [add/remove/clear]` | Exclude models. `remove <provider>/*` also clears a usage-limit exclusion of that provider. |

### Manual pin

`/router-manual` keeps `router/auto` as the active model.

- The pin exists only in the current `RouterSession`. The command never writes `settings.json` or the pi8 config.
- A pinned turn serves only the pinned model. If that model fails, the router shows the failure and does not substitute another model.
- `/router-manual resume` leaves the pin. The next user entry reuses the auto decision from just before the pin. Later turns route normally.
- A change to Pi's thinking level, for example with Shift+Tab, also sets a pin. The pin uses the model that served the last turn, at the new level. Before the first served turn, the change affects only the next turn.
- A new session clears the pin.

## Configuration

`~/.pi/agent/pi8/config.json` (optional, created on first use):

```jsonc
{
  "models": ["github-copilot/*"],       // allowlist: which providers to route over
  "blacklist": ["*/gemini-experimental"], // persisted exclude patterns
  "prompt": true,                        // notify when model switches
  "semi": false,                         // ask before switching away from the last served model
  "switchMargin": 0.15,                 // cap on cache credit and compliance penalty
  "routerContextWindow": 200000,         // cap on router/auto's window (default: served model's window)
  "reputation": true,                   // global counts and exact-prefix cross-session cache credit
  "debug": false                         // enable timing log
}
```

The full configuration reference is in [`ARCHITECTURE.md`](ARCHITECTURE.md#8-configuration-reference).

## Observability

- **Decision log**: one append-only JSONL file for each session, next to Pi's transcript: `<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`. Each routing decision records the task type, chosen model, cause, and fallback order. `work-lifecycle` records contain completion, prior-completion, and gate outcomes, and each settle reminder with whether the model then followed it, as IDs and categories, without reply text or work-item titles. A session without a saved session file writes to the shared `~/.pi/agent/pi8/decisions.jsonl`.
- **Global model history**: `~/.pi/agent/pi8/model-events.jsonl` is append-only. It stores model IDs, opaque entry/prompt hashes, timestamps and event categories, never requests, tool arguments, file paths or reply text. Routing folds only the current reminder-rule version and the last 90 days. Interrupted reminders and continuations answered by another model do not count as ignores.
- **Debug timing log** (turn it on with `debug`): per-step timing in milliseconds, in a per-session `*.router-debug.log` file. A session without a saved session file writes to `/tmp/pi8-debug.log`.

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md): implementation details, including how the task type is resolved, scoring tiers, the delegation loop, escalation, the work lifecycle, and subagent injection.
- [`AGENTS.md`](AGENTS.md): contributor rules and known traps.
