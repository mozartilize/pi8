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

The full reference is in [Configuration](docs/configuration.md).

## Observability

- **Decision log:** `<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl` — model selections, fallbacks, and work lifecycle. Without a saved session: `~/.pi/agent/pi8/decisions.jsonl`.
- **Global model history:** `~/.pi/agent/pi8/model-events.jsonl` — protocol counts and cache history.
- **Debug log:** `<session-dir>/*.router-debug.log` — opt-in attempt and turn timings. Without a saved session: `/tmp/pi8-debug.log`.

See [Observability](docs/observability.md) for configuration, log locations, and privacy limits.

## Further reading

- [Overview](docs/overview.md): setup, architecture, configuration, commands, routing, subagents, benchmarks, logs, and glossary.
