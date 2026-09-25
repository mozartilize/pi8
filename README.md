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

1. Create a free API key at [artificialanalysis.ai](https://artificialanalysis.ai/).
2. Run `/router-sync <your-key>` once.
3. Set the session model to `router/auto`.

Without steps 1 and 2, the router still works. It uses Pi's registry metadata (price and context window), but it has no quality signal.

## How it works

```
/router-sync → benchmark data
                    ↓
          classify + assess → task dimension
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

1. **Classify.** A fast English keyword classifier puts the request into one of five dimensions: lightweight, gather, plan, implement, or review. When the keywords give no evidence, an optional local multilingual embedding classifier (E5-small) fills the gap. Examples are non-English prompts and ambiguous input.
2. **Assess.** An optional LLM assessment reads the meaning of the task to add confidence.
3. **Score.** The router scores every available model against live benchmarks and registry metadata: quality, cost, speed, and context window. A model that is not capable enough stays in the fallback chain, but it never becomes the top pick.
4. **Stream.** The router streams the reply from the top pick. If that model fails before any output, the router moves to the next model in the chain. Failures include missing credentials, a timeout, and a provider error. After an answer or a tool call starts to stream, the router never replays the turn.
5. **Hand off.** When a `plan` or `review` turn has settled every decision, the model can call `commit_execution` with the remaining file changes and checks, and rate the remaining work from 1 to 5 on five criteria: open decisions, spread, verification, knowledge needed, and coupling. The router, not the model, turns the ratings into the minimum quality an executor needs. It also measures the plan itself: the number of files and folders, the size of the files, and how often recent commits fixed them. A plan with more than 2 files or 4 steps needs at least a `standard`-band executor; one with more than 5 files or 8 steps, open design decisions, or a missing file stays with the current model.
   - If the executor edits a file outside the plan, writes files from a shell command, re-plans, or struggles, the next step returns to the planning model.
   - When the executor has edited every listed file, the planning model takes over as a reviewer until the end of your message, so checks listed after the last edit run during that review. If it submits a new plan instead, that counts against the executor.
   - A model that breaks or needs rework on two plans in one task is replaced by a strictly stronger model one band higher.
   - If the model edits before submitting a plan, the router appends one reminder to that edit's result.
   - An investigation (`gather`) turn whose findings show that files must change can call `request_planning`. The rest of your message then routes as `plan`: a planning model decides the change, and makes it or hands it off with `commit_execution`. If the investigation edits without it, the router appends one reminder to that edit's result.
   - `/router-why` shows the plan on its `plan:` line. The decision log records each plan's ratings, measurements, and outcome, so the weights can be fitted to real results later.
6. **Route subagents.** At spawn time, the router scores each visible structured child. It uses the role's minimum task type, the task, scoring weights, and how full the context is. The task assessment can only raise that minimum. Explicit child models and user or project pins always win. For children inside a `workflowScript` string, the router sets only the tool's default model. See [`ARCHITECTURE.md`](ARCHITECTURE.md#4-subagent-routing) for the details.

Uncertainty always routes up. Missing data, an ambiguous prompt, or low confidence never makes routing cheaper.

pi8 has no effect on a session that uses a concrete model instead of `router/auto`.

### Compound tasks

Some requests have an investigation step and a fix step, for example "investigate X, then fix it". When the fix needs a frontier-level model, the router uses two phases:

- Investigation can start on a cheaper standard-level or strong-level model.
- When the first mutation (`edit` or `write`) starts, the router hands the turn to a model that meets the requirement of the fix.
- The router tries to switch to a stronger model once for each file change. If none is available, it lets the change continue.
- The router also detects file-writing `bash` commands when it can and handles them the same way.

## Commands

| Command | Purpose |
|---|---|
| `/router-sync [key]` | Fetch new benchmark data |
| `/router-sync embedding [--force]` | Download the E5-small model (~135 MB) and check it against `embedding-manifest.json` (sha256). Report whether the runtime can be imported. |
| `/router-status` | Show data freshness, coverage, pin state, assessment spend, and the last decision |
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
- A pinned turn skips the assessment and serves only the pinned model. If that model fails, the router shows the failure and does not substitute another model.
- `/router-manual resume` leaves the pin. The next user entry reuses the auto decision from just before the pin, with no new classification or assessment. Later turns route normally.
- A change to Pi's thinking level, for example with Shift+Tab, also sets a pin. The pin uses the model that served the last turn, at the new level. Before the first served turn, the change affects only the next turn.
- A new session clears the pin.

## Configuration

`~/.pi/agent/pi8/config.json` (optional, created on first use):

```jsonc
{
  "models": ["github-copilot/*"],       // allowlist: which providers to route over
  "blacklist": ["*/gemini-experimental"], // persisted exclude patterns
  "consultRouter": true,                 // await and apply semantic assessment
  "prompt": true,                        // notify when model switches
  "semi": false,                         // ask before switching away from the last served model
  "switchMargin": 0.15,                 // prefer the current model to keep the prompt cache
  "routerContextWindow": 200000,         // cap on router/auto's window (default: served model's window)
  "debug": false,                        // enable timing log
  "embeddingClassifier": false,          // enable multilingual E5-small classifier
  "embeddingDeadlineMs": 5000,           // max ms for model load + inference
  "embeddingMinConfidence": 0.15         // minimum lead of the top classification
}
```

Set `consultRouter` to `false` for fully local routing. The router then sends no assessment requests. `embeddingClassifier` needs the **optional** packages `onnxruntime-node` and `@xenova/transformers`. Without them, the layer stays disabled.

The full configuration reference is in [`ARCHITECTURE.md`](ARCHITECTURE.md#9-configuration-reference).

## Observability

- **Decision log**: one append-only JSONL file for each session, next to Pi's transcript: `<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`. Each routing decision records the task type, chosen model, cause, and fallback order. Separate assessment records show how the assessment changed the keyword result. A session without a saved session file writes to the shared `~/.pi/agent/pi8/decisions.jsonl`.
- **Debug timing log** (turn it on with `debug`): per-step timing in milliseconds, in a per-session `*.router-debug.log` file. A session without a saved session file writes to `/tmp/pi8-debug.log`.

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md): implementation details, including scoring tiers, the delegation loop, assessment privacy, escalation, and subagent injection.
- [`AGENTS.md`](AGENTS.md): contributor rules and known traps.
