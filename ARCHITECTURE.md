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

Candidates are expanded per supported (model, effort) pair. One registry model may produce several routable candidates when bench rows exist at different effort levels — each with its own quality/cost/speed measurement. A supported level the source never measured is covered by an estimate stepped down from the nearest measured level above it, marked `qualityEstimated` (see "Effort estimation"). `off` rows are emitted even for non-reasoning models (their only serveable mode). When all measured efforts are unsupported by the model's `thinkingLevelMap`, the model falls back to a single effort-less candidate.

### Effort estimation

Sources publish rows only for the effort levels they measured, so a fully serveable level (e.g. `sonnet-5:medium`) can have no row while `high` and `max` do. Such a level is estimated from the nearest measured level **above** it, minus a per-step quality drop; estimation is strictly downward, so nothing above the highest measured row is ever invented.

The per-step drop is derived from the store on each sync — the p90 of observed adjacent-level drops, computed per quality axis — rather than fixed. p90 rather than the median is the point: at the median an estimate lands above the true value roughly half the time, at p90 it under-shoots ~90% of the time, which is what lets an estimate compete for the pick at all. An axis with too few observations is left unestimated rather than extrapolated from noise.

Estimated rows carry price and context window (registry facts that hold across effort levels) but never `costPerTask`, speed, or latency — those are per-run measurements of one specific level. Estimated quality is eligible on the normal capability floor, but **economic promotion requires measured evidence**: promotion relaxes the floor on price grounds, and relaxing it for inferred capability too would stack one inference on another.

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

Per-call cost basis: `costPerTask` when every candidate in the pre-promotion tier-0 pool carries it (the full filtered set when no candidate reaches tier 0); otherwise blended `$/1M` tokens (input×0.25 + output×0.75). Scoping to the pool that can actually win keeps a low-quality candidate missing task cost from forcing an otherwise covered set onto the coarser basis — which matters because effort variants of one model share a `$/1M` rate and are only distinguishable by task cost. Registry pricing is authoritative when present; benchmark pricing is a fallback. Free models with benchmark data are real (zero-cost is deliberate); free models without benchmark data are treated as unknown (no cost credit).

### Switch penalty

Incumbent models receive a cache-preservation bonus priced from the incumbent's own registry economics, not a flat unitless rate: `perTokenLoss = cacheWrite (or input, if no cacheWrite) − cacheRead`, the dollar value of one warm cache token. An exact incumbent match credits `min(estContextTokens × perTokenLoss, switchMargin)` — the full conversation. A same-model effort change credits only `min(staticPrefixTokens × perTokenLoss, switchMargin)`, since an effort change invalidates message blocks but the system/tool prefix cache stays warm; a same-model candidate with no measured effort (the model's default call shape) gets the full credit like an exact match. A different model gets zero credit — a model change has no cache entries to begin with. When the incumbent's registry entry doesn't publish enough pricing to compute `perTokenLoss` (no `cacheRead`, and no `cacheWrite`/`input`), no retention credit is granted at all. Capped by `switchMargin` (default 0.15). Applies only when the caller supplies an incumbent and does not set `isSubagentSpawn`; role injection supplies neither, so a subagent spawn never receives the bonus (no cache to lose).

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

## 7. Terminal work and multi-work routing

Covers explicit compound implementation requests — "find X, then fix it" — where the terminal deliverable (a mutation) is harder than its own inspect phase. Ordinary intents are unaffected: this machinery only engages for `implement`-dimension turns whose terminal classification is compound and discount-eligible.

### Terminal classification (`terminal-classifier.ts`)

A pure, deterministic structural classifier — separate from the keyword/semantic dimension classifiers — extracts one `TerminalAssessment` per entry: `kind` (same vocabulary as `Dimension`), `complexity` (`trivial`|`routine`|`moderate`|`hard`|`frontier`), `scope` (`bounded`|`open-ended`), `compound`, `confidence`, and `discountEligible`. `compound` requires an explicit prerequisite → sequence → mutation structure (e.g. "investigate the race condition, then fix it"); anything defaulted (complexity or scope inferred rather than matched) withholds `discountEligible` — the inspect-phase discount is a licence, so only unambiguous evidence earns it.

### Terminal requirement and capability band (`work-phase.ts`)

```
requirement = clamp01(KIND_BASE[kind] + 0.5 × COMPLEXITY[complexity] + (scope === 'open-ended' ? 0.1 : 0))
```

| Band | Requirement | Floor |
|---|---|---|
| `economy` | < 0.30 | none |
| `standard` | < 0.50 | 0.45 |
| `strong` | < 0.75 | 0.70 |
| `frontier` | ≥ 0.75 | 0.85 |

### Phase lifecycle

Each intent owns one `WorkPhase`: `answer` (lightweight), `inspect` (gather, or an engaged compound implementation's opening phase), `reason` (plan/review), `mutate` (implement, or a compound implementation once it has left `inspect`). Multi-work only *engages* — granting the inspect-phase discount — when the terminal kind is compound-eligible implement, band is `strong` or `frontier`, confidence isn't low, the resolved dimension is `implement`, and no capability repick is active. Once engaged, phase advances `inspect` → `mutate` when a stronger routing owner takes over (dimension changes away from `implement`, or a capability repick activates) — never automatically downward, and never once the turn leaves `inspect`.

### Scoring policy (`scorer.ts`)

An engaged intent supplies a request-local `MultiWorkScoringPolicy` — `terminalFloor` (the terminal band's floor) and `inspectFloor` (one band below, while still in `inspect`) — instead of the ordinary live tier/promotion parameters. This is the *only* place quality can be measured below terminal preference: a bounded, deterministic economic promotion for the inspect phase, not an uncertainty downgrade. Every scored candidate also carries `CandidateCapabilityMeta` (`taskRatio`, `clearsTerminalFloor`, `viaInspectPromotion`) so the caller knows, per candidate, whether it actually clears the terminal floor or only the inspect floor.

### Materializing served capability (`delegation.ts`)

Capability is evaluated for the *candidate that actually serves* the turn, not the top-ranked pick — fallback can serve a weaker sibling. `ServedCapabilityMeta` (provider invocation, terminal floor, whether any candidate in the scoring set ever cleared it, and the served candidate's own capability) is materialized before decision state is published, so the mutation gate always reads settled evidence for the invocation that is actually streaming.

### Mutation gate (`mutation-gate.ts`)

Pure, fail-open, invocation-bounded state transitions gating `edit`/`write` tool calls. While engaged and still in `inspect`, a mutation call is blocked once per provider invocation unless served capability already clears the terminal floor (`clearsTerminalFloor === true`) or is genuinely unknown (`'unknown'` proceeds — unmeasured is not proof of insufficiency, and blocking on it would wait forever). A later invocation after a block always escapes — one bounded handoff, not a hard veto, since the router cannot guarantee a stronger model exists. Missing or incoherent served-capability evidence fails open immediately rather than stalling the turn. A blocked call returns as an error tool result, prompting the agent to request another provider turn (per Pi's tool-call/tool-result contract).

### Assessor v2 contract (`assessment-prompt.ts`)

`ASSESSMENT_PROMPT_VERSION = '2.0.0'`. The assessor returns the same `{ kind, complexity, scope, compound, confidence, reasoning }` shape as the terminal classifier (`ParsedAssessment`/`RoutingAssessment`), replacing the prior `dimension`/`outcome`/`scope: AssessmentScope` contract. Shadow and active modes dispatch the identical prompt and parser — shadow logs an `assessment-shadow` decision-log record without influencing routing; active may adopt the verdict. The assessor's `complexity`/`compound` fields inform terminal classification only — they never gate routing directly, and there is no automatic verify-phase down-routing.

### Decision surfacing

`RoutingDecision.multiWork` (a `MultiWorkRoutingMeta`) is present only for engaged intents. `/router-status` and `/router-why` (`formatDecisionDetail` in `ui.ts`) print terminal kind/complexity/band and phase/invocation, the actual served capability ratio (or `unknown` without a measured ratio), and a gate line only when a block/escape actually occurred. Decisions without engaged multi-work metadata render exactly as before.

---

## 8. Data flow

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

## 9. Configuration reference

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
| `consultRouterAgent` | — | Legacy input alias; use `consultRouter` (canonical) for new configs |

---

## 10. Non-goals

- Semantic answer grading or automatic retries on perceived quality
- Replaying after visible text or a tool call, or replacing a running child in-place
- Execution-verified feedback loops / outcome memory
- Acting as a model gateway/proxy for non-Pi tools

---

## 11. Development

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
