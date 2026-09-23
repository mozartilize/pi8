# pi8 - pi coding agent extension auto model router

Benchmark-aware auto model router for [Pi](https://github.com/earendil-works/pi-coding-agent). Routes each turn — and each [pi-subagents](https://www.npmjs.com/package/pi-subagents) role — to the best available model based on live intelligence/coding benchmarks, Pi's registry metadata, and automatic classification. No manual per-session model picking.

## Why

If you have multiple authenticated providers, you're normally choosing a model by hand — per session, per subagent role — with no data. Model benchmarks (intelligence, coding, price, speed) are public. This extension fetches them, matches them against Pi's model registry, and routes every turn to the best cost/quality match automatically.

## Disclaimer

**Heavy AI assistance** — this extension is developed with heavy AI assistance; use at your own risk.

## Install

```json
// ~/.pi/agent/settings.json or .pi/settings.json
{
  "packages": ["git:github.com/mozartilize/pi8"]
}
```

For local development, point Pi at a checkout via `.pi/extensions/` or `pi -e /path/to/index.ts`.

## Quick start

1. Get a free API key at [artificialanalysis.ai](https://artificialanalysis.ai/).
2. Run `/router-sync <your-key>` once.
3. Set your session's model to `router/auto`. Done.

Without step 1–2, the router still works using Pi's registry metadata (price, context window) — no quality signal, but better than nothing.

## How it works

```
/router-sync → benchmark data
                    ↓
          classify + assess → task dimension
                    ↓
         pick best (model, effort) → fallback chain
                    ↓
             delegate with automatic retry
```

Every turn the router automatically:

1. **Classifies** your request into one of five dimensions (lightweight, gather, plan, implement, review) — a fast English keyword classifier runs first. When it has no categorical evidence (non-English prompts, ambiguous input), an optional **local multilingual embedding classifier** (E5-small) fills the gap.
2. **Assesses** the task semantically with an optional LLM consultation for additional confidence.
3. **Scores** every available model against live benchmarks and registry metadata (quality, cost, speed, context window). Models that aren't capable enough stay in the fallback chain but never win the top spot.
4. **Streams** the best match. If it fails before producing output — missing credentials, timeout, provider error — the router moves to the next best model automatically. Once an answer or tool call starts streaming, it never replays.
5. **Routes subagents too** — visible structured role children are re-scored at spawn from the role floor plus their task, configured dimension weights, and current context pressure; task assessment only raises the role requirement. Explicit child models and user/project pins still win, and reviewer children are kept independent from selected worker families. Children inside a `workflowScript` string are opaque, so the router fills only the tool's top-level model slot with its worker-first default (worker → planner → researcher → advisor → reviewer); per-child script models still win and scripted failures remain ordinary tool errors.

Uncertainty always routes up: missing data, ambiguous prompts, and low confidence never make routing cheaper. Overserving is cheap; underserving costs a bad answer.

All `router/auto` intents run through this same pipeline. For an explicit compound implementation request ("investigate X, then fix it"), the router automatically recognizes that its terminal deliverable — the fix — is harder than its own inspect phase, and lets one frontier-band intent open at a cheaper, standard/strong-band model for inspection before handing off to a model that clears the terminal requirement once mutation (`edit`/`write`) starts. This activates automatically whenever it applies — there's no configuration key or hidden switch for it. The handoff is bounded to one attempt per mutation call; if no stronger model is available, the router degrades to letting the mutation through rather than stalling the turn. `edit`/`write` calls are always governed by the gate; `bash` is classified best-effort, and high-confidence write shapes feed the same bounded handoff — file redirection (`>`, `>>`, `>|`, `&>`, excluding fd duplication and `/dev/null`-style sinks), `sed`/`perl` in-place edits, `tee`/`patch`/`git apply`/`truncate`/`touch`, `cp`/`mv`/`rm`/`install`/`mkdir`/`ln`, `dd of=`, and inline Python write APIs (`open` write modes, `Path`/`os`/`shutil` mutations). Opaque Python (`python script.py`, `python -m`, eval/subprocess indirection) is allowed and recorded in the decision log as enum signals only — never as command text; other unrecognized forms are allowed without a mutation signal. Static detection is best effort, not a guarantee: hooks run in load order and Bash applies its own spawn hook later, so a command can be rewritten after this extension observes it, and writes hidden behind aliases, `bash -c` strings, wrapper commands such as `env`/`xargs`, imports, or obfuscation can slip through. Concrete-model sessions (a specific model, not `router/auto`) are completely unaffected.

## Commands

| Command | Purpose |
|---|---|
| `/router-sync [key]` | Fetch fresh benchmark data |
| `/router-sync embedding [--force]` | Download the E5-small embedding model (~135 MB) for multilingual classification |
| `/router-status` | Show freshness, coverage, manual-pin state, last decision |
| `/router-manual [provider/model[:thinking]\|resume]` | Pin one model for this session; Space shows searchable model completions, Enter opens Pi's native `/model` picker, and `resume` reuses the pre-pin route for the next turn |
| `/router-semi [on\|off]` | Ask before switching away from the last served model (persists `semi` in config) |
| `/router-why` | Explain why the last model was chosen |
| `/router-models` | Show allowlist and matching models |
| `/router-agents` | Show which model each subagent role resolves to |
| `/router-fix <slug> <id>` | Override a benchmark-to-registry mapping |
| `/router-blacklist [add/remove/clear]` | Exclude models; `remove <provider>/*` also lifts a usage-limit provider exclusion |

`/router-manual` keeps `router/auto` active and stores the pin only in the current `RouterSession`; it never writes `settings.json` or the pi8 config. Manual turns skip the assessment call and serve exactly the selected model. The fallback chain contains one model, so failure is surfaced instead of substituting another model. `/router-manual resume` leaves the pin and reuses the auto decision that was in effect just before it was set — the same chosen model and fallback chain, with no fresh classification or assessment — for the next user entry only; subsequent turns recompute normally. A new session clears the pin automatically.

## Configuration

`~/.pi/agent/pi8/config.json` (optional; created on first use):

```jsonc
{
  "models": ["github-copilot/*"],       // allowlist: which providers to route over
  "blacklist": ["*/gemini-experimental"], // persisted exclude patterns
  "consultRouter": true,                 // await and apply semantic assessment
  "prompt": true,                        // notify when model switches
  "semi": false,                         // ask before switching away from the last served model
  "switchMargin": 0.15,                 // cache-preservation bonus for incumbent
  "routerContextWindow": 200000,         // window advertised for router/auto (default: largest routable)
  "debug": false,                        // enable timing log
  "embeddingClassifier": false,          // enable multilingual E5-small classifier
  "embeddingDeadlineMs": 5000,           // max ms for model load + inference
  "embeddingMinConfidence": 0.15         // min top-two margin before blending
}
```

- `models` / `blacklist`: `*` wildcards, case-insensitive. Bare provider name = `provider/*`.
- `consultRouter`: when `true`, awaits one bounded assessment per real user entry and applies its verdict under strict safety caps. Set `false` for fully local routing with no assessment egress.
- `semi`: when `true`, the router asks before switching away from the model that served the previous turn (Yes / keep this turn / pin `provider/model-id[:thinking]`, which acts as `/router-manual`). No prompt on the first pick of a session, and a no-op without an interactive UI.
- `switchMargin`: how strongly the router prefers keeping the current model to preserve prompt cache. Set to `0` to disable.
- `routerContextWindow`: the context window advertised for the synthetic `router/auto` model. Pi tunes compaction to the session model's window, so the default (the largest window among models your `models`/`blacklist` config actually lets the router pick) delays compaction on long sessions and biases them toward large-window models as context grows past each smaller model's window. Set this to the effective window you want to route within to make Pi compact earlier and keep cheaper, smaller-window models eligible longer. An override above the largest routable window is clamped down to it — you cannot advertise capacity no routable model actually has.
- `debug`: `true` or a file path enables per-turn millisecond timing logs.
- `embeddingClassifier`: when `true`, a local E5-small embedding model classifies prompts where the keyword classifier has no evidence — non-English languages, ambiguous English. Blends up only; never overrides keyword downward. Requires the **optional** `onnxruntime-node` and `@xenova/transformers` packages to be installed (they are not hard dependencies — without them the layer stays disabled). `/router-sync embedding` reports whether the runtime is importable alongside the model download.
- `embeddingDeadlineMs`: maximum milliseconds the embedding model load + inference may take (default 5000). On expiry the keyword result is used unchanged.
- `embeddingMinConfidence`: minimum confidence (the margin between the top two prototype scores) for the embedding verdict to influence routing (default 0.15). Below it the embedding abstains and the keyword result stands — a low-confidence embedding never moves routing. Download integrity: provisioned files are verified against `embedding-manifest.json` (sha256) on every `/router-sync embedding`, so a corrupt model file is re-downloaded rather than silently used.

Full configuration reference in [`ARCHITECTURE.md`](ARCHITECTURE.md#8-configuration-reference).

## Observability

- **Decision log** — one append-only JSONL sidecar per session, next to Pi's transcript: `<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`. Every routing decision records dimension, chosen model, cause, and fallback chain; separate `assessment-metric` records preserve heuristic deltas and latch-veto evidence. Ephemeral sessions (no persisted session file) fall back to a shared `~/.pi/agent/pi8/decisions.jsonl`.
- **Debug timing log** (opt-in via the `debug` config) — per-step millisecond timing, written as a per-session `*.router-debug.log` sidecar (`/tmp/pi8-debug.log` when ephemeral).

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — full implementation details: scoring tiers, delegation loop, assessment privacy, escalation protocols, subagent injection.
- [`AGENTS.md`](AGENTS.md) — contributor conventions and module responsibilities.
