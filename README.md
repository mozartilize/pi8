# pi8 - pi coding agent extension auto model router

Benchmark-aware auto model router for [Pi](https://github.com/earendil-works/pi-coding-agent). Routes each turn — and each [pi-subagents](https://www.npmjs.com/package/pi-subagents) role — to the best available model based on live intelligence/coding benchmarks, Pi's registry metadata, and automatic classification. No manual per-session model picking.

## Why

If you have multiple authenticated providers, you're normally choosing a model by hand — per session, per subagent role — with no data. Model benchmarks (intelligence, coding, price, speed) are public. This extension fetches them, matches them against Pi's model registry, and routes every turn to the best cost/quality match automatically.

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
5. **Routes subagents too** — each subagent role gets a concrete model selected per spawn.

Uncertainty always routes up: missing data, ambiguous prompts, and low confidence never make routing cheaper. Overserving is cheap; underserving costs a bad answer.

## Commands

| Command | Purpose |
|---|---|
| `/router-sync [key]` | Fetch fresh benchmark data |
| `/router-sync embedding [--force]` | Download the E5-small embedding model (~135 MB) for multilingual classification |
| `/router-status` | Show freshness, coverage, last decision |
| `/router-why` | Explain why the last model was chosen |
| `/router-escalate [dimension]` | Re-route to a stronger model |
| `/router-models` | Show allowlist and matching models |
| `/router-agents` | Show which model each subagent role resolves to |
| `/router-fix <slug> <id>` | Override a benchmark-to-registry mapping |
| `/router-blacklist [add/remove/clear]` | Exclude models; `remove <provider>/*` also lifts a usage-limit provider exclusion |

## Configuration

`~/.pi/agent/pi8/config.json` (optional; created on first use):

```jsonc
{
  "models": ["github-copilot/*"],       // allowlist: which providers to route over
  "blacklist": ["*/gemini-experimental"], // persisted exclude patterns
  "assessmentMode": "shadow",            // "shadow" (default) or "active"
  "consultRouter": true,                 // enable semantic assessment
  "prompt": true,                        // notify when model switches
  "switchMargin": 0.15,                 // cache-preservation bonus for incumbent
  "debug": false,                        // enable timing log
  "embeddingClassifier": false,          // enable multilingual E5-small classifier
  "embeddingDeadlineMs": 5000            // max ms for model load + inference
}
```

- `models` / `blacklist`: `*` wildcards, case-insensitive. Bare provider name = `provider/*`.
- `assessmentMode`: `"shadow"` runs the assessment in the background without affecting routing. `"active"` lets it adjust the task dimension under strict safety caps.
- `switchMargin`: how strongly the router prefers keeping the current model to preserve prompt cache. Set to `0` to disable.
- `debug`: `true` or a file path enables per-turn millisecond timing logs.
- `embeddingClassifier`: when `true`, a local E5-small embedding model classifies prompts where the keyword classifier has no evidence — non-English languages, ambiguous English. Blends up only; never overrides keyword downward. Requires `onnxruntime-node` and `@xenova/transformers` to be installed.
- `embeddingDeadlineMs`: maximum milliseconds the embedding model load + inference may take (default 5000). On expiry the keyword result is used unchanged.

Full configuration reference in [`ARCHITECTURE.md`](ARCHITECTURE.md#8-configuration-reference).

## Observability

- **Decision log** — one append-only JSONL sidecar per session, next to Pi's transcript: `<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`. Every routing decision: dimension, chosen model, cause, fallback chain. Ephemeral sessions (no persisted session file) fall back to a shared `~/.pi/agent/pi8/decisions.jsonl`.
- **Debug timing log** (opt-in via `debug` config or `PI_AUTO_ROUTER_DEBUG`) — per-step millisecond timing, written as a per-session `*.router-debug.log` sidecar (`/tmp/pi8-debug.log` when ephemeral).

## Known limitations

- **Benchmark coverage drives quality.** Models with no matched benchmark row route on registry metadata only (price, context window) — no quality signal. Coverage depends on what Artificial Analysis publishes and how well slugs fuzzy-match your registry.
- **Matching can need manual overrides.** A benchmark slug that doesn't match a registry id needs a `/router-fix <slug> <id>` mapping; until then that model has no quality data.
- **Provider availability is only known at stream time.** An authenticated provider can still 421/hang/error on a specific model. The router detects this and walks the fallback chain, but the first attempt's latency is already spent.
- **A usage-limit error excludes the whole provider for the session.** When a model fails with a quota/usage-limit error (OpenCode Go `GoUsageLimitError`, OpenAI `insufficient_quota`, billing/credit exhaustion, plain 429/rate-limit, …) the entire provider is blacklisted — every model on it shares the same exhausted cap, so retrying siblings wastes time. The provider is skipped for the rest of the session (`/router-blacklist remove <provider>/*` lifts it after a top-up). Model-specific output-limit exhaustion stays model-scoped.
- **Fallback is objective-only, and one-way after output.** There is no answer-quality grading — only pre-answer failure signals trigger fallback. Once text or a tool call has streamed, the router never replays, so a poor-but-complete answer stands.
- **`active` assessment adds cost and egress.** In `active` mode a bounded prompt (recent conversation, tool/skill names — never arguments or file contents) is sent to an authenticated assessor provider, adding spend. `shadow` (default) dispatches nothing that affects routing.

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — full implementation details: scoring tiers, delegation loop, assessment privacy, escalation protocols, subagent injection.
- [`AGENTS.md`](AGENTS.md) — contributor conventions and module responsibilities.
