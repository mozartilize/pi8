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

Sync reads both the API and the public models page, so `/router-sync` needs Chromium. If either source fails, sync keeps the previous store. Pi does not need a restart after the browser install.

`router/auto` routes only from synced benchmark data that includes the models-page measurements. Without that data, selecting `router/auto` shows an error, and automatic turns stop with a message to run `/router-sync`; they make no model call. A manual pin and concrete-model sessions are unaffected. A missing browser does not stop routing: the current data stays in use, and selecting `router/auto` shows a warning that `/router-sync` cannot refresh it.

The capability minimums are calibrated for Artificial Analysis Intelligence Index version 4.3. When a sync reports a different version, the router saves the data, keeps routing, and shows a warning at sync, at `router/auto` selection, and in `/router-status`.

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
   - The trusted readers include `fffind` and `ffgrep`. Shell runners, mutation tools, and unknown tools remain blocked during collection. A refused call directs the model to an allowed reader, not an early handoff.
   - Source-dependent ratings require source inspection. `facts.decisions` names unresolved behavior, interface, or design choices. `facts.unknowns` records missing evidence. An unknown source location is not a design choice. Unsupported optional rubrics can be omitted. Missing criteria inherit the highest supplied level. No ratings retain task defaults, and the final-step requirement can still raise the minimum.
2. **Score.** The router scores every available model against live benchmarks and registry metadata: quality, cost, speed, and context window. A model below a capability minimum stays behind measured suitable and unknown models in the fallback chain. Price and cache credit cannot move it across those tiers.
3. **Stream.** The router streams the reply from the top pick. If that model fails before any output, the router moves to the next model in the chain. Failures include missing credentials and provider errors. The router sets no auth or output deadline; Pi or the user can cancel a pending request. After an answer or a tool call starts to stream, the router never replays the turn.
4. **Hand off.** A model serving `plan`, `review`, or `implement` can call `commit_execution` only for changes the user authorized. A plan-only or review-only request does not permit implementation. Once every remaining file change and verification command is specified, the model submits the plan before editing. It rates only the remaining implementation, not the completed investigation. The five criteria are open decisions, spread, verification, knowledge needed, and coupling, each rated from 1 to 5. The router, not the model, turns the ratings into the minimum quality an executor needs. It also measures the plan itself: the number of files and folders, the size of the files, and how often recent commits fixed them. A plan with more than 2 files or 4 steps needs at least a `standard`-band executor; one with more than 5 files or 8 steps, an open behavior, interface, or design decision (`openDecisions` 4 or 5), or a missing file stays with the current model. So does a plan whose executor minimum is above the current model's measured quality: if that model struggles, escalation moves the work one step up.
   - If the executor edits a file outside the plan, writes files from a shell command, re-plans, or struggles, the next step returns to the planning model.
   - When the executor has edited every listed file, the planning model takes over as a reviewer until the end of your message, so checks listed after the last edit run during that review. If it submits a new plan instead, that counts against the executor.
   - A model that breaks or needs rework on two plans in one task is replaced by a strictly stronger model one band higher.
   - Accepted implementation handoffs and reopenings include closed-plan guidance for the next step. An unplanned edit can receive an additional reminder in a plan/review turn, or when incumbent minimums raised an implementation pick.
   - `/router-why` shows the plan on its `plan:` line. The decision log records each plan's ratings, measurements, and outcome, so the weights can be fitted to real results later.
5. **Route subagents.** At spawn time, the router scores each visible structured child. It uses the role's minimum task type, the task, scoring weights, and how full the context is. Explicit child models and user or project pins always win. For children inside a `workflowScript` string, the router sets only the tool's default model. See [`ARCHITECTURE.md`](ARCHITECTURE.md#4-subagent-routing) for the details.

Uncertainty always routes up. Missing data or a missing declaration never makes routing cheaper.

pi8 has no effect on a session that uses a concrete model instead of `router/auto`.

When you return to `router/auto` after requests to another model, the router does not continue the active work item: the next request collects context and chooses again. The requests you sent to the other model can be found again as earlier work.

### Capability and model preferences

Production minimums do not change when the request's candidate pool changes:

| Task type | Minimums for the preferred tier |
|---|---|
| `lightweight` | none |
| `gather` | intelligence ≥ 20 |
| `plan`, `review` | intelligence ≥ 30, Omniscience ≥ 0, Briefcase rubric pass rate ≥ 0.35 |
| `implement` | agentic coding ≥ 34 |

Agentic coding is the Terminal-Bench 4.0 pass rate in percent. It supplies the default implement minimum and ranking axis. An explicit implement requirement below 0.45 uses the AA Agentic Index instead, with a minimum of `requirement × 57.9`. A handoff without a scored criterion keeps the default minimum. This economy rule needs independent outcome validation. A model without a Terminal-Bench 4.0 result gets a conservative estimate from the older Artificial Analysis indexes and counts as estimated quality. Omniscience measures closed-book correctness: zero means correct answers balance incorrect answers. Briefcase measures work from source files against deliverable checks. Both are required for plan/review. Hallucination rate is not a separate minimum. Missing measurements rank ahead of measured weak values, behind models that meet all minimums. A measured failure on one axis is not erased by a missing value on another.

Accepted handoffs use their rubric and band requirement against fixed reference strengths, rather than a request-local maximum. An implement handoff with a `bounded` scope and no open behavior, interface, or design choice (`openDecisions` ≤ 3) takes at most 65% from its rubric; its final step can still raise the minimum. Long requests (≥ 64,000 tokens) also need LCR ≥ 0.30; image requests need MMMU-Pro ≥ 0.30. Missing values remain unknown. Speed uses time per task when the preferred tier has complete coverage; otherwise it uses output tokens per second.

Every recently served candidate can get prompt-cache credit, priced from its own registry cache rates and capped by `switchMargin`. After the two-week collection period, cross-session credit additionally requires an identical system prompt and tool schema at the same provider, model and effort; it expires after one hour. Selection counts earn no points.

`model-events.jsonl` collects protocol counts across sessions. Penalties are **off until two weeks of data have been collected and `reputationWeights` has been configured**. Fit the weights from those observations. They need at least 30 decayed entries for reminder rate or 10 completed reminder episodes for ignore rate. Counts have a 30-day half-life. Penalties cannot cross capability tiers or remove fallbacks. `/router-status` shows the counts and `/router-why` explains a penalty that changed preference. Set `reputation: false` to disable collection, cross-session credit and penalties. Execution outcome bonuses are not enabled.

### Development comparator

The evaluation-only `cheapest-sufficient` policy uses Intelligence for every implementation requirement. It has no named capability bands or requirement-based benchmark switch. No component rule is enabled without independent outcome validation. Other task minimums and input-shape minimums remain unchanged.

Its fixed implementation minimum is `0.65 × 57.6` (about 37.4). Explicit implementation requirements use `requirement × 57.6`. These are unvalidated comparator parameters, not equivalent capability across benchmarks or proven task sufficiency. Missing Intelligence remains unknown; coding and subset indexes cannot replace it.

Selection, incumbent comparisons, escalation, and excluded-executor replacement use the same metric identity. Recovery keeps the complete required vector, including long-context and vision minimums. Capability tiers precede cost; all tiers remain available for provider fallback. Decision records include the capability policy digest, metric version, required vector, and benchmark snapshot digest. The reporting cost baseline retains production capability comparisons.

Production remains `legacy`. Paid evaluation and activation require separate approval.

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
- Another extension can call the session model with its own thinking level, for example a background memory agent. That request gets its level, but it does not set a pin and does not change Pi's thinking level.
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
- **Debug timing log** (turn it on with `debug`): per-step timing in milliseconds, in a per-session `*.router-debug.log` file. Each attempt also records auth time, time to the first event and first text/tool call, total duration, longest silence after auth, and output-state flags in the decision log. Missing milestones are absent, not zero. A session without a saved session file writes to `/tmp/pi8-debug.log`.

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md): implementation details, including how the task type is resolved, scoring tiers, the delegation loop, escalation, the work lifecycle, and subagent injection.
- [`AGENTS.md`](AGENTS.md): contributor rules and known traps.
