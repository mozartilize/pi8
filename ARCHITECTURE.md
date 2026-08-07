# ARCHITECTURE.md — pi8

Implementation-level architecture for the router. For user-facing setup and commands, see [`README.md`](README.md). For contributor conventions, see [`AGENTS.md`](AGENTS.md).

## Pipeline overview

```
/router-sync (on demand, warns when data is >14 days stale)
   └─ adapter: artificial-analysis  (REST, free API key)
        normalize + fuzzy-match against Pi's live model registry
~/.pi/agent/pi8/benchmarks.json
        ▼
classify + assess (per user entry) → one of 5 dimensions
        ▼
pickBest(candidates × measured effort, dimension, weights) → ranked fallback chain
        ▼
delegate to top (model, effort) candidate; on objective pre-answer failure, walk the chain
```

Every turn:

1. **Resolve intent** — two classifiers run per real user entry.
2. **Score** — expand (model, effort) candidates, capability-gate, rank by quality/cost/speed.
3. **Delegate with objective fallback** — stream, handle pre-answer failures, walk the chain.
4. **Route subagents** — inject a concrete model per spawn via `tool_call` hook.

---

## 1. Intent resolution

### Keyword classifier (deterministic fallback)

A fast local keyword/intent classifier ported from LiteLLM's `complexity_router.py` (Apache-2.0). Maps the request to a task dimension using five keyword lists (code, reasoning, technical, simple, gather) plus dimension-specific markers (review, plan, intent verbs). Weighted-sum scoring with LiteLLM's dimension weights produces a confidence score; ties are broken by dimension strength. The resolved intent is cached per user entry key and reused through that entry's Pi tool loop.

Thin approvals and transitions (e.g. `ok go for it` or `what's next?`) use at most 1,500 characters of role-labelled user/assistant context ending at that entry, keyed differently so a full-classification turn and its thin continuation share the same intent dimension.

The keyword classifier is frozen in semantic scope — it exists as a survivable fallback, not a policy engine. Structural thresholds (depth escalation tokens, assessment deadlines, input caps) remain tunable; keyword lists and scope rules do not.

### Semantic assessment (enabled by default)

The always-on assessment dispatches a bounded model call — selected from the routable pool under a competence floor (`assessorQualityRatio`, default 0.5 of the strongest routable intelligence) — asking only what kind of work this is. The deterministic scorer still owns which models serve.

One assessment per real user entry, bounded by one end-to-end deadline (`assessmentDeadlineMs`, default 1500ms). Input is capped by `assessmentMaxInputChars` (default 6000), truncated oldest-first, and credential-scrubbed before dispatch.

**`shadow` mode** (default): the assessment runs detached — adds no wall-clock time to the turn and writes a counterfactual `assessment-shadow` record in the decision log (joined by `intentKey`). Routing is byte-identical to `consultRouter: false`.

**`active` mode**: verdicts may be adopted under strict caps:

- Uncertainty always routes up: low-confidence assessments yield `max(heuristic, oneTierAbove(verdict))`, never anything below the heuristic.
- Only a **high-confidence, `scope: bounded`** verdict may lower the dimension, by **at most one tier**, never from `implement` or `review`, and never while the depth latch is engaged.
- Capability repick: a consult that raised the dimension owns that decision (`router-consult` cause remains active for capability repick purposes).

Unlike `shadow`, `active` adds assessor spend and egress to the turn — that is the price of adopting verdicts; `shadow` (default) adds no wall-clock time and dispatches nothing that affects routing.

Set `consultRouter: false` to keep routing fully local with no assessment dispatched.

---

## 2. Scoring (`scorer.ts`)

### Candidate expansion

Candidates are expanded per measured and supported (model, effort) pair. One registry model may produce several routable candidates when bench rows exist at different effort levels — each with its own quality/cost/speed measurement. An effort level with no measurement is never synthesized (unmeasured is unknown quality). `off` rows are emitted even for non-reasoning models (their only serveable mode). When all measured efforts are unsupported by the model's `thinkingLevelMap`, the model falls back to a single effort-less candidate.

### Capability tiers

Models are classified into three tiers based on capability relative to the strongest request-local peer:

| Tier | Criterion |
|---|---|
| 0 | Task-axis ratio ≥ frontier ratio (85%), and if `implement`/`review`: broad-capability ratio ≥ sanity floor (45%) |
| 1 | Unknown quality (ranks behind tier-0 known but ahead of tier-2 weak) |
| 2 | Below floor (weak on task axis or fails sanity) |

Every tier stays in the fallback chain: a capability judgement controls the preferred model, never objective failure recovery.

### Dimension-to-axis mapping

| Dimension | Task axis (eligibility gate) | Quality axis (ranking) |
|---|---|---|
| `lightweight` | intelligence (no floor applied) | intelligence |
| `gather` | intelligence | intelligence |
| `plan` | intelligence (never promoted) | intelligence |
| `implement` | agenticCoding → coding (fallback) | agenticCoding → coding (fallback) |
| `review` | coding → intelligence (ranking only) | coding → intelligence |

`implement` uses agentic-coding as primary axis (AA's `artificial_analysis_agentic_index`), falling back to coding when absent. Ranking axes fall back so every model sorts on real data; eligibility axes do not (requires direct evidence).

### Economic promotion (bounded)

A tier-2 candidate may earn tier 0 only when it clears **all** of:

1. Task-axis ratio ≥ economy floor (70%)
2. Sanity floor (if `implement`/`review`)
3. Price ≤ cheapest tier-0 peer ÷ 4 (fourfold advantage)
4. Not Pareto-dominated by a cheaper, equally-capable peer
5. Non-sibling: a different provider of the same bench row doesn't count as a peer

Promotion is evaluated for `gather`, `implement`, and `review` only. `plan` is never promoted and `lightweight` is ungated entirely.

### Cost signal

Per-call cost basis: `costPerTask` when every candidate carries it; otherwise blended `$/1M` tokens (input×0.25 + output×0.75). Registry pricing is authoritative when present; benchmark pricing is a fallback. Free models with benchmark data are real (zero-cost is deliberate); free models without benchmark data are treated as unknown (no cost credit).

### Switch penalty

Incumbent models receive a cache-preservation bonus as context grows: `min(estContextTokens × 0.000005, switchMargin)`. This accounts for prompt-cache economics — cached input can be ~10x cheaper than fresh, and switching forfeits the whole conversation's cache. Capped by `switchMargin` (default 0.15). Applies only when the caller supplies an incumbent and does not set `isSubagentSpawn`; role injection supplies neither, so a subagent spawn never receives the bonus (no cache to lose).

### Effort floor

Minimum reasoning effort per dimension — a **floor**, not an assignment. A measured effort may raise it, never lower it:

| Dimension | Min thinking |
|---|---|
| `lightweight` | off |
| `gather` | low |
| `implement` | medium |
| `review` | high |
| `plan` | max |

The router-chosen effort uses an **up-only walk** (`levelFrom`) from the clamped floor — a gap in the `thinkingLevelMap` never resolves below the floor. Explicit user reasoning requests use a nearest-first walk to honour the user's choice as closely as possible.

---

## 3. Delegation fallback loop (`delegation.ts`)

The loop walks the ranked fallback chain (each entry is a `provider/id:effort` key) and streams the first candidate that produces meaningful output.

Provider availability is only resolved at stream time. Registry auth-filtering is per-provider, not per-model, and the per-attempt credential check is the real gate — an authenticated provider can still 421/hang/error on a specific model. The fallback chain absorbs the failure, but the first attempt's latency is already spent.

### Pre-answer failure modes

| Failure | Handling |
|---|---|
| Not in registry | Blacklisted, next candidate |
| No credentials / auth timeout (5s) | Blacklisted, provider strike |
| First event timeout (30s) with no text/thinking/tool | Next candidate |
| Provider `stopReason: error` | Retried same-candidate (up to 2 transient / 1 generic retry), then next candidate |
| Clean `done` with no text/thinking/tool output | Next candidate |
| Reasoning-only exhausted (`stopReason: length`, no visible text/tool) | Next candidate |
| User abort | Terminal, no blacklist |

### Provider circuit breaker

Three provider-health strikes (credential, auth, transport, `stopReason: error`) skip that provider's remaining models. Model-specific output-limit exhaustion and missing-registry failures do not condemn the provider — a sibling model on the same provider remains reachable.

A usage-limit error — quota/billing exhaustion, OpenCode `GoUsageLimitError`, or a plain 429/rate-limit — blacklists the whole provider for the session immediately, bypassing the three-strike accumulation: the cap is shared by every model on it, so retrying siblings wastes time. Model-specific output-limit exhaustion never triggers it. `/router-blacklist remove <provider>/*` lifts the exclusion after a top-up.

### Effort resolution per chain entry

Each chain entry carries its own effort from the bench row. Router-chosen efforts are clamped to the dimension floor and resolved via up-only walk (`levelFrom`). Explicit user reasoning requests use nearest-first walk (`resolveThinkingLevel`) so the user's choice is honoured as closely as the model supports.

### Post-content irreversibility

Once visible text or a tool call has streamed, the router never replays on another model — that would duplicate output or side effects. A later error is reported to the stream instead.

---

## 4. Subagent routing

### Role injection

pi-subagents roles (`researcher`, `planner`, `worker`, `reviewer`, `advisor`) each map to a dimension via `ROLE_DIMENSIONS`. On each spawn, the router builds candidates from the registry + store, scores for that dimension, and injects the concrete `provider/model` into the subagent tool call via a `tool_call` hook.

Nothing is written to `settings.json` — injection is per-spawn only. Explicit model choices and user/project pins (`source` ≠ `pi8`) always win. A concrete child cannot switch models mid-process.

### Subagent escalation (parent-assisted respawn)

A synchronous router-owned child with a knowable stable result index receives a bounded self-report contract. If it returns only the contract marker (capability limitation), the router appends a retry directive naming the next model in the role's fallback chain to the tool result. The **parent must synchronously respawn the same role/task once, omitting an explicit model**, so the router injects the one-shot override.

Fixed parallel same-role tasks key the directive to the original task. Bounded dynamic fanout preserves one role-wide override; async children and unknown-span fanout fail open (concrete injection continues, escalation contract omitted).

### Provider auth filter

Before subagent role assignment, a per-provider credential probe (timeout 3s) filters out unauthenticated providers. Without this, a pick-once subagent spawn naming an unauthenticated provider would hard-fail. A total probe failure means authentication is unknown, not known-successful — no injection occurs.

---

## 5. Depth escalation

Covers the transition the classifier cannot see: a gather session that keeps accumulating context has become synthesis over gathered material, which cheap tiers serve badly.

- **Trigger**: live context exceeds `depthEscalationTokens` (default 32768), turn is classified lightweight/gather, no active routing intent (escalation/user override)
- **Effect**: raise one tier for that invocation (cause: `context-depth`)
- **Properties**: up-only, never cached, per-invocation evaluation
- **Latch veto**: the first depth-latch transition per session may be vetoed by a high-confidence, `scope: bounded` assessment. A veto is a refusal to escalate — dimension and cause stay unchanged — and it reuses the entry's existing assessment verdict rather than dispatching a second one. Every failure path (timeout, no assessor, unparseable reply, disabled assessment) escalates without a veto.

---

## 6. Escalation mechanisms (3 distinct paths)

### 1. Main-conversation capability escalation
Run `/router-escalate [dimension]` yourself, or let the serving model call `route_up` before a substantive answer. No argument raises one tier; an explicit dimension weaker than the last routed one is rejected. At the same dimension, a quality-first capability repick excludes the requesting model. Override lasts `escalationTtlTurns` turns or 5 minutes.

### 2. Main-stream automatic fallback
The delegation loop reacts only to objective pre-answer failures. No semantic-quality inference, no replay after visible output.

### 3. Synchronous subagent retry
Parent-assisted respawn described in §4. User-pinned roles are never overridden.

---

## 7. Data flow

### Benchmarks

The **Artificial Analysis** Data API (free tier, `x-api-key` header) provides the sole benchmark source. Rows carry `evaluations` (intelligence, coding, agentic indices), `pricing` ($/1M input/output), and `performance` (tokens/sec, TTFT, TTFA). Quality coverage is bounded by what Artificial Analysis publishes: a model with no matched row carries no quality signal and routes on registry metadata alone.

**Effort labels** are parsed from the model name parenthetical: `GPT-5.6 Luna (low)`, `Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)`, `DeepSeek V4 Flash (Non-reasoning)` → `off`. The parse fails closed (unrecognized → undefined).

**Run variants**: AA re-runs benchmarks under different configurations, suffixing slugs with `-<4 digits>` (e.g. `gpt-5-6-luna-low-1234`). These are stripped via an explicit variant list in `matcher.ts`. The variant list is explicit rather than a general stripping rule because generic suffix-stripping corrupts real model identities like `qwen3.7-max`.

**Store format**: identity is `(registryId, effort)` — NUL-separated in storage, `provider/id:effort` in candidate keys. v2 stores discard v1 stores with a single warn line. Selected sources refresh as one transaction — a partial source outage preserves the previous store rather than stamping a partial dataset.

### Fuzzy matching

Benchmark slugs are fuzzy-matched against Pi's live registry model IDs. Manual overrides are available via `/router-fix` when matching fails; until an override lands, the unmatched model has no quality data and routes on registry metadata only.

### Decision log

Append-only per-session sidecar next to the Pi transcript (`<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`; ephemeral sessions without a persisted session file share `~/.pi/agent/pi8/decisions.jsonl`): dimension, chosen model, cause, fallback chain, capability-gate diagnostics, assessment verdicts, shadow counterfactuals. Caused values: `heuristic`, `continuation-context`, `user-escalation`, `router-consult`, `model-escalation`, `capability-escalation`, `error-fallback`, `no-data`, `context-depth`, `self-healing-gap`.

### Timing log

Per-step millisecond timing (opt-in via the `debug` config): registry wait, classification, per-candidate auth/stream attempts, turn totals. Written as a per-session `*.router-debug.log` sidecar (`/tmp/pi8-debug.log` when ephemeral).

---

## 8. Configuration reference

Options in `~/.pi/agent/pi8/config.json`:

| Key | Default | Description |
|---|---|---|
| `artificialAnalysisApiKey` | — | Saved by `/router-sync` |
| `models` | `[]` (all) | Allowlist: provider/id glob patterns |
| `blacklist` | `[]` | Persisted exclude patterns |
| `escalationTool` | `true` | Register `route_up` tool |
| `escalationTtlTurns` | `4` | Model `route_up` override duration |
| `consultRouter` | `true` | Master switch for semantic assessment |
| `consultModel` | — | Optional assessor model override |
| `assessmentMode` | `"shadow"` | `"shadow"` or `"active"` |
| `assessmentDeadlineMs` | `1500` | End-to-end assessor budget |
| `assessmentMaxInputChars` | `6000` | Assessor input cap |
| `assessorQualityRatio` | `0.5` | Assessor competence floor |
| `depthEscalation` | `true` | Auto-raise on deep context |
| `depthEscalationTokens` | `32768` | Context-token threshold |
| `prompt` | `true` | TUI notification on model switch |
| `switchMargin` | `0.15` | Incumbent cache-preservation cap |
| `debug` | `false` | Timing log path or `true` |
| `syntheticPrefixes` | `[]` | Literal prefixes marking synthetic messages |
| `dimensionWeights` | per-dimension defaults | Override `{quality, cost, speed}` per dimension |
| `lowConfidenceThreshold` | `0.15` | Classifier confidence below which uncertainty handling applies |
| `sources` | — | Benchmark source selection |
| `consultRouterAgent` | — | Legacy alias read only when `consultRouter` is absent |

---

## 9. Non-goals

- Semantic answer grading or automatic retries on perceived quality
- Replaying after visible text or a tool call, or replacing a running child in-place
- Execution-verified feedback loops / outcome memory
- Acting as a model gateway/proxy for non-Pi tools

---

## 10. Development

```bash
npm run check   # tsc --noEmit + vitest run
```

Core modules:
- `scorer.ts` — pure scoring, `pickBest`, capability tiers, effort resolution (no I/O)
- `classifier.ts` — pure keyword classification (no I/O)
- `consult.ts` — assessment dispatch: streaming model call, parse, timeout
- `delegation.ts` — fallback loop: auth, retries, circuit breaker, timeouts
- `provider.ts` — orchestrator: registry wait, classify/escalate/consult, score, delegate; also owns `buildSubagentProviderAuthFilter`, the 3s per-provider credential probe
- `index.ts` — hook wiring; runs the credential probe before role assignment
- `adapters/` — benchmark data sources (currently only `artificial-analysis.ts`)
- `subagents.ts` — role injection, escalation contracts (no probe of its own)
