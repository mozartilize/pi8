# ARCHITECTURE.md — pi8

Implementation-level architecture for the router. For user-facing setup and commands, see [`README.md`](README.md). For contributor conventions, see [`AGENTS.md`](AGENTS.md).

## Terms and minimums

- **Task type (`Dimension`)**: one of `lightweight`, `gather`, `plan`, `implement`, or `review`. **Capability tier**: 0 (eligible on measured quality), 1 (quality unknown), or 2 (measured but below the task's requirement). **Capability band**: `economy`, `standard`, `strong`, or `frontier`, used for the final step of a compound task. These are three different scales; raising the task type does not mean raising a capability tier.
- **Final step (`terminal` in code)**: the requested outcome after investigation, often a file change. A stream's terminal event instead ends one model attempt. **Inspect phase**: the investigation before that change. Its bounded discount permits a model one capability band below the final step's requirement until the change begins.
- **Economic promotion**: measured evidence can admit a cheaper tier-2 model when it meets the 70% task-quality minimum and the other conditions in §2. Estimated quality cannot qualify.
- **Trajectory friction (TFI)**: objective signs of a stalled attempt, such as repeated actions or verifier failures; not a judgment of the answer's meaning. **Provider circuit/strike**: a provider-level failure counter; three strikes temporarily exclude that provider. A shared usage limit excludes it immediately.
- **Session generation/currentness**: a generation changes on session reset; asynchronous results check that they still belong to the active generation before writing state. **Assessment egress**: the limited task context sent to a separate assessor provider. **Provenance** labels whether text came from a user, assistant, or summary; the assessor's **output ontology** is its allowed structured verdict vocabulary.
- **Sidecar**: the per-session decision-log file beside Pi's transcript. **Seam**: a deliberate test hook for replacing a path, timeout, or runtime dependency.

Each *minimum* has a different subject: the **heuristic minimum task type** prevents uncertain assessments from lowering the keyword classification; the **role minimum task type** constrains subagent picks; the **incumbent capability minimum** keeps the serving model at or above the previous served candidate's quality on the routed task axis, while its **minimum thinking level** constrains effort separately. The **dimension effort minimum** sets reasoning per task type. The **assessor competence minimum** gates which model may assess a request. For measured model quality, the **tier-0 task minimum** defaults to 85% of the strongest peer, the **economic-promotion minimum** is 70%, and the **broad-capability sanity minimum** is 45% for implementation/review. A compound task's **final-step capability minimum** comes from its band; its **investigation capability minimum** is one band lower while the discount applies. Name the subject rather than saying only “floor.”

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

Verdicts are adopted under strict caps:

- Uncertainty always routes up: low-confidence assessments yield `max(heuristic, oneTierAbove(verdict))`, never anything below the heuristic.
- Only a **high-confidence, `scope: bounded`** verdict may lower the dimension, by **at most one tier** (or release an unassisted keyword ambiguity bump to `rawHeuristic`), never from `implement` or `review`, and never while the depth latch is engaged.
- Trajectory repick: a consult that raised the dimension owns that decision (`router-consult` cause remains active for trajectory repick purposes).

Each attempt writes an `assessment-metric` decision-log record joined by `intentKey`, preserving the heuristic delta or fallback reason. A depth-latch transition writes a second metric from the same single assessment dispatch. Assessment spend is tracked separately from routed spend.

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

### Current-model cache preference

The incumbent is the actually served (model, effort) variant when it is still in the routable candidate pool; otherwise the last scored choice is used. Its capability minimum chooses the first chain candidate with known task-axis quality at least as high as that incumbent's, rather than forcing that same model to serve. If the incumbent is absent from the scored chain (for example, insufficient context capacity), the minimum never restores it. Incumbent models receive a cache-preservation bonus priced from the incumbent's own registry economics, not a flat unitless rate: `perTokenLoss = cacheWrite (or input, if no cacheWrite) − cacheRead`, the dollar value of one warm cache token. An exact incumbent match credits `min(estContextTokens × perTokenLoss, switchMargin)` — the full conversation. A same-model effort change credits only `min(staticPrefixTokens × perTokenLoss, switchMargin)`, since an effort change invalidates message blocks but the system/tool prefix cache stays warm; a same-model candidate with no measured effort (the model's default call shape) gets the full credit like an exact match. A different model gets zero credit — a model change has no cache entries to begin with. When the incumbent's registry entry doesn't publish enough pricing to compute `perTokenLoss` (no `cacheRead`, and no `cacheWrite`/`input`), no retention credit is granted at all. Capped by `switchMargin` (default 0.15). Applies only when the caller supplies an incumbent and does not set `isSubagentSpawn`; role injection supplies neither, so a subagent spawn never receives the bonus (no cache to lose).

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

### Session-scoped manual pin

`/router-manual [provider/model[:thinking]|resume]` leaves `router/auto` as Pi's active model and stores the pin only in `RouterSession`; `reset()` clears it. A manual turn skips the assessment dispatch, restricts scoring to the pinned model's candidates, records cause `manual-override`, and truncates the fallback chain to the chosen effort variant. Delegation therefore has one model in its chain: failure is surfaced rather than substituting another model (ordinary same-model retry policy still applies).

A thinking-level change the router did not write (Shift+Tab, settings, or another extension's `pi.setThinkingLevel`) also sets a pin: the model that served the previous invocation, at the new level clamped to what that model supports. An existing pin moves to the new level. Pi's `thinking_level_select` carries no source and also fires for the router's own footer sync and for model switches, so the router detects the change at the next provider invocation instead: it compares `options.reasoning` with the level Pi held right after the router's last sync (`syncedThinkingLevel`). A switch to `router/auto` clears that baseline. Before any model has served, the change stays a one-turn effort override.

`/router-manual resume` leaves manual mode and reuses the pre-pin route. Setting the first pin snapshots the auto decision then in effect (`resumeSnapshot`); `resume` arms that snapshot and discards pin-owned pending trajectory escalation so automatic routing does not act on stale evidence. The next router turn serves the snapshot's chosen model and fallback chain directly — no classification, assessment, or scoring — under cause `resume`, filtered to the still-routable chain entries (an empty result falls through to ordinary routing). The one-shot is scoped to a single user entry by `resumeIntentKey`: same-entry tool-loop continuations reuse it, the next entry expires it and recomputes. When no pin (or armed snapshot) is active, `resume` is a no-op.

The command's argument completer provides the `/model `-style searchable model list after Space. The no-argument command reuses Pi's exported `ModelSelectorComponent` (the native `/model` search/navigation UI). Because a pin is an explicit override, the list mirrors Pi's own `/model` exactly — session-scoped models when the session is scoped, otherwise every authenticated registry model — and deliberately does **not** apply the router's allowlist, config/session blacklist, usage-limit, or scoped filters; only the synthetic `router/*` provider is dropped. Serving a pin outside the router's candidate pool expands it on demand from the registry (bypassing the build-time routing filters). The session failure blacklist does not exclude a pin either: a repeat failure surfaces the provider's own error, matching the pinned-only, surface-failure contract. Semi-mode holds still honor it. Nothing is written to `settings.json` or config.

When `semi: true`, a scored pick that differs from the previously-served model waits on `ctx.ui.select` before delegating: Yes uses the new model, No keeps the incumbent for this user entry only (cause `semi-hold`; same-entry tool-loop continuations reuse it), and a specific `provider/model-id[:thinking]` sets the session pin like `/router-manual`. Fallbacks after a failed attempt ask again. Dismiss/abort cancels the turn instead of switching. Non-interactive sessions skip the gate. `/router-semi [on|off]` persists the flag.

### Pre-answer failure modes

| Failure | Handling |
|---|---|
| Not in registry | Blacklisted, next candidate |
| No credentials / auth timeout (5s) | Blacklisted, provider strike |
| First event timeout (30s) with no text/thinking/tool | Next candidate |
| Provider `stopReason: error` | Retried same-candidate (up to 2 transient / 1 generic retry), then next candidate |
| Clean `done` with no text/thinking/tool output | Next candidate |
| Same, answering a tool result | Handed off: the same candidate is asked once more with a router-authored user turn appended ("Continue the task from the tool results above."), then next candidate. Providers that run their own agent loop (e.g. a Claude Code bridge) only accept tool results for calls they made, but start a fresh query from a user turn with the whole history, so they can pick up another model's tool loop. The turn exists only in the delegated request, never in Pi's transcript, and the decline itself is neither blacklisted nor a provider strike. |
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

pi-subagents roles (`researcher`, `planner`, `worker`, `reviewer`, `advisor`) each provide a minimum dimension via `ROLE_DIMENSIONS`. The router builds and auth-filters the candidate snapshot during session refresh, then re-scores each visible structured child at spawn time from its role and task. `assessTerminal(task)` may raise the role floor, never lower it; configured dimension weights and the live context guard apply to that pick before the concrete `provider/model` is injected through the `tool_call` hook. Workflow-script children are opaque to the structured walker, so those calls retain the worker-first tool-level default (worker → planner → researcher → advisor → reviewer) rather than task-aware per-child routing. A per-child `model` inside the script still wins, and scripted failures remain ordinary tool errors. Reviewer children are kept independent from the selected worker's model family.

Nothing is written to `settings.json` — injection is per-spawn only. Explicit model choices and user/project pins (`source` ≠ `pi8`) always win. A concrete child cannot switch models mid-process.

### Usage-limit exclusion

A foreground child that fails with a provider usage-limit error (quota/billing/subscription cap, matched by `isUsageLimitErrorMessage` — the same classifier the main stream uses) excludes that whole provider for the session, so later spawns and main turns skip every model on it (rule 8: the cap is shared provider-wide). Per-attempt errors attribute the cap to the exact model. This is the only non-retryable child failure that persists: transient errors are retried by pi-subagents/the model, and request-specific failures (invalid request, refusal) say nothing about provider health. The router never retries or respawns the child — recovery is the parent's decision.

### Provider auth filter

Before subagent role assignment, a per-provider credential probe (timeout 3s) filters out unauthenticated providers. Without this, a pick-once subagent spawn naming an unauthenticated provider would hard-fail. A total probe failure means authentication is unknown, not known-successful — no injection occurs.

---

## 5. Depth escalation

Covers the transition the classifier cannot see: a gather session that keeps accumulating context has become synthesis over gathered material, which cheap tiers serve badly.

- **Trigger**: live context exceeds `depthEscalationTokens` (default 32768), the pre-depth dimension is lightweight/gather, and the cause is depth-passive (`heuristic`, `continuation-context`, `no-data`, or `router-consult`)
- **Effect**: raise the task type by one step for that invocation (cause: `context-depth`)
- **Properties**: up-only, never cached, per-invocation evaluation
- **One-time exception**: only the first such upgrade per session may be cancelled by a high-confidence assessment with `scope: bounded`. The task type and cause then stay unchanged; the router reuses the assessment for this entry instead of making another request. If assessment times out, is unavailable or disabled, or returns an invalid reply, the upgrade proceeds.

---

## 6. Escalation mechanisms (2 distinct paths)

### 1. Objective trajectory escalation
Objective trajectory friction (repeated action/observation, persistent verifier failure, confirmed stagnation, pre-output reasoning loops) sets a pending same-dimension quality-first repick for the next provider invocation, or hops immediately when replay is still safe. Models do not self-escalate.

### 2. Main-stream automatic fallback
The delegation loop reacts only to objective pre-answer failures. No semantic-quality inference, no replay after visible output, a tool call, or a thinking-overflow commit.

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

Each intent owns one `WorkPhase`: `answer` (lightweight), `inspect` (gather, or an engaged compound implementation's opening phase), `reason` (plan/review), `mutate` (implement, or a compound implementation once it has left `inspect`). Multi-work only *engages* — granting the inspect-phase discount — when the terminal kind is compound-eligible implement, band is `strong` or `frontier`, confidence isn't low, and the resolved dimension is `implement`. Once engaged, phase advances `inspect` → `mutate` when a stronger routing owner takes over (the resolved dimension changes away from `implement`) — never automatically downward, and never once the turn leaves `inspect`.

### Scoring policy (`scorer.ts`)

An engaged intent supplies a request-local `MultiWorkScoringPolicy` — `terminalFloor` (the terminal band's floor) and `inspectFloor` (one band below, while still in `inspect`) — instead of the ordinary live tier/promotion parameters. This is the *only* place quality can be measured below terminal preference: a bounded, deterministic economic promotion for the inspect phase, not an uncertainty downgrade. Every scored candidate also carries `CandidateCapabilityMeta` (`taskRatio`, `clearsTerminalFloor`, `viaInspectPromotion`) so the caller knows, per candidate, whether it actually clears the terminal floor or only the inspect floor.

### Materializing served capability (`delegation.ts`)

Capability is evaluated for the *candidate that actually serves* the turn, not the top-ranked pick — fallback can serve a weaker sibling. `ServedCapabilityMeta` (provider invocation, terminal floor, whether any candidate in the scoring set ever cleared it, and the served candidate's own capability) is materialized before decision state is published, so the mutation gate always reads settled evidence for the invocation that is actually streaming.

### Mutation gate (`mutation-gate.ts`)

Pure, fail-open, invocation-bounded state transitions gating `edit`/`write` tool calls. While engaged and still in `inspect`, a mutation call is blocked once per provider invocation unless served capability already clears the terminal floor (`clearsTerminalFloor === true`) or is genuinely unknown (`'unknown'` proceeds — unmeasured is not proof of insufficiency, and blocking on it would wait forever). A later invocation after a block always escapes — one bounded handoff, not a hard veto, since the router cannot guarantee a stronger model exists. Missing or incoherent served-capability evidence fails open immediately rather than stalling the turn. A blocked call returns as an error tool result, prompting the agent to request another provider turn (per Pi's tool-call/tool-result contract).

### Assessor v2 contract (`assessment-prompt.ts`)

`ASSESSMENT_PROMPT_VERSION = '2.0.0'`. The assessor returns the `{ kind, complexity, scope, compound, confidence, reasoning }` shape as defined by the terminal classifier (`ParsedAssessment`/`RoutingAssessment`). Successful verdicts are adopted under the caps in §1 and recorded as `assessment-metric` entries. The assessor's `complexity`/`compound` fields inform terminal classification only — they never gate routing directly, and there is no automatic verify-phase down-routing.

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

### Session state & lifecycle

Routing state is encapsulated into instantiable domain aggregates:
- `RouterSession`: Root session container owning session generation, last decision/served model, candidate expansion cache, embedding tallies, and domain sub-objects. Cleared on `session_start` or test resets.
- `BlacklistState`: Encapsulates model and provider runtime exclusions, as well as session glob patterns with case-insensitive normalization.
- `AssessmentState`: Tracks assessor spend, input/output usage EMA, and per-model strike counts.
- `IntentState`: Manages cached routing intent across tool loops, depth-latch generation, latch veto intent key, and compound work-phase state.
- `RuntimeBindings`: Stores Pi's `ExtensionContext`, active `modelRegistry`, and provider registration signature. Persists across `session_start` resets and clears only on extension shutdown or reload.

### Decision log

Append-only per-session sidecar next to the Pi transcript (`<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`; ephemeral sessions without a persisted session file share `~/.pi/agent/pi8/decisions.jsonl`): dimension, chosen model, cause, fallback chain, capability-gate diagnostics, assessment verdicts, and `assessment-metric` records. Cause values: `heuristic`, `continuation-context`, `router-consult`, `embedding-classify`, `error-fallback`, `no-data`, `capability-escalation`, `trajectory-escalation`, `context-depth`, `self-healing-gap`, `manual-override`, `resume`, `semi-hold`.

### Timing log

Per-step millisecond timing (opt-in via the `debug` config): registry wait, classification, per-candidate auth/stream attempts, turn totals. Written as a per-session `*.router-debug.log` sidecar (`/tmp/pi8-debug.log` when ephemeral).

---

## 9. Configuration reference

Options in `~/.pi/agent/pi8/config.json`:

| Key | Default | Description |
|---|---|---|
| `artificialAnalysisApiKey` | — | Saved by `/router-sync` |
| `models` | `[]` (all) | Allowlist: provider/id glob patterns (`*` wildcards, case-insensitive; a bare provider name means `provider/*`) |
| `blacklist` | `[]` | Persisted exclude patterns, same syntax as `models` |
| `consultRouter` | `true` | Master switch for semantic assessment; `false` dispatches no assessment request |
| `consultModel` | — | Optional assessor model override |
| `assessmentDeadlineMs` | `1500` | End-to-end assessor budget |
| `assessmentMaxInputChars` | `6000` | Assessor input cap |
| `assessorQualityRatio` | `0.5` | Assessor competence floor |
| `depthEscalation` | `true` | Auto-raise on deep context |
| `depthEscalationTokens` | `32768` | Context-token threshold |
| `prompt` | `true` | TUI notification on model switch |
| `semi` | `false` | Ask before switching away from the last served model |
| `switchMargin` | `0.15` | Incumbent cache-preservation cap; `0` disables the bonus |
| `routerContextWindow` | served model's window | Context window advertised for `router/auto`. Pi tunes compaction to it, so `router/auto` advertises the window and output limit of the model that last served, and the largest routable window before any model has served. A lower value makes Pi compact earlier and keeps smaller-window models eligible longer. Values above the default are clamped to it. |
| `debug` | `false` | Timing log path or `true` |
| `syntheticPrefixes` | `[]` | Literal prefixes marking synthetic messages |
| `dimensionWeights` | per-dimension defaults | Override `{quality, cost, speed}` per dimension |
| `lowConfidenceThreshold` | `0.15` | Classifier confidence below which uncertainty handling applies |
| `sources` | — | Benchmark source selection |
| `consultRouterAgent` | — | Legacy input alias; use `consultRouter` (canonical) for new configs |
| `embeddingClassifier` | `false` | Local E5-small classifier for prompts without keyword evidence; up-only; needs optional `onnxruntime-node` and `@xenova/transformers` |
| `embeddingDeadlineMs` | `5000` | Model load + inference budget; on expiry the keyword result stands |
| `embeddingMinConfidence` | `0.15` | Minimum top-two prototype margin before the embedding verdict applies |

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
- `subagents.ts` — role injection (no probe of its own)
