# ARCHITECTURE.md — pi8

Implementation-level architecture for the router. For user-facing setup and commands, see [`README.md`](README.md). For contributor conventions, see [`AGENTS.md`](AGENTS.md).

## Terms and minimums

- **Task type (`Dimension`)**: one of `lightweight`, `gather`, `plan`, `implement`, or `review`. **Capability tier**: 0 (eligible on measured quality), 1 (quality unknown), or 2 (measured but below the task's requirement). **Capability band**: `economy`, `standard`, `strong`, or `frontier`, used for a declared final step and for an execution contract's executor. These are three different scales; raising the task type does not mean raising a capability tier.
- **Final step (`terminal` in code)**: the requested outcome that a ready `hand_off_context` or `reopen_work` declares as `deliverable`, `complexity`, and `scope`. A stream's terminal event instead ends one model attempt.
- **Economic promotion**: measured evidence can admit a cheaper tier-2 model when it meets the 70% task-quality minimum and the other conditions in §2. Estimated quality cannot qualify.
- **Trajectory friction (TFI)**: objective signs of a stalled attempt, such as repeated actions or verifier failures; not a judgment of the answer's meaning. **Provider circuit/strike**: a provider-level failure counter; three strikes temporarily exclude that provider. A shared usage limit excludes it immediately.
- **Session generation/currentness**: a generation changes on session reset; asynchronous results check that they still belong to the active generation before writing state. **Provenance** labels whether text came from a user, an assistant, a summary, or a known synthetic source such as a router settle reminder.
- **Sidecar**: the per-session decision-log file beside Pi's transcript. **Seam**: a deliberate test hook for replacing a path, timeout, or runtime dependency.

Each *minimum* has a different subject: the **role minimum task type** constrains subagent picks; the **incumbent capability minimum** keeps the serving model at or above the previous served candidate's quality on the routed task axis, while its **minimum thinking level** keeps chain entries of the incumbent model at or above the effort it served at. For measured model quality, the **capability minimums** are fixed per task type and do not depend on the candidate pool (see §2, Capability tiers); a handoff requirement is a share of a fixed reference strength per axis. A plan or review handoff's **reasoning minimum** is the higher of its rubric requirement and its final step's band minimum (`standard` 45%, `strong` 70%, `frontier` 85%). An execution contract's **executor implement minimum** is the higher of the requirement computed from the submitter's rubric and the router's measurements (30% at least) and the minimum of the contract's band (`economy` 30%, `standard` 45%, `strong` 70%). Name the subject rather than saying only “floor.”

## Pipeline overview

```
/router-sync (on demand, warns when data is >14 days stale)
   └─ adapter: artificial-analysis  (REST, free API key)
        normalize + fuzzy-match against Pi's live model registry
~/.pi/agent/pi8/benchmarks.json
        ▼
task type: incumbent's, or gather until hand_off_context declares the next step
        ▼
pickBest(candidates × measured effort, dimension, weights) → ranked fallback chain
        ▼
delegate to top (model, effort) candidate; on objective pre-answer failure, walk the chain
```

Every turn:

1. **Resolve the task type** — from router-owned state and the model's accepted declarations; no prompt classifier runs.
2. **Score** — expand (model, effort) candidates, capability-gate, rank by quality/cost/speed.
3. **Delegate with objective fallback** — stream, handle pre-answer failures, walk the chain.
4. **Route subagents** — inject a concrete model per spawn via `tool_call` hook.

---

## 1. Task type

No prompt classifier runs. An entry's task type comes from state the router owns and from declarations it accepts (`entryPhase` in `context-acquisition.ts`):

- With no incumbent, an entry routes as `gather` (cause `investigation`) and collects context. The gathering gate (`gathering-gate.ts`) allows only trusted readers, the question tool, `hand_off_context`, and `routing_context`; a refused mutation or subagent call, or a rejected handoff, counts against the entry, and two refusals turn it `clarification-only`, where it may only ask the user. Collecting context ends after a bounded number of requests.
- `hand_off_context` ends collecting context. A ready handoff declares `deliverable`, `complexity`, and `scope`, selects or creates the work item, and the next invocation routes at that deliverable (cause `investigation-handoff`). A declared direct answer creates no work and no incumbent; `needs-user` hands the request back to the user.
- An incumbent serves later entries at its task type with every tool (cause `incumbent`) until it hands off. After completion, that model serves the next entry under the completed-work gate instead (§6).
- Mid-intent `plan`/`review` changes to `implement` only through an accepted execution contract (§6, cause `execution-contract`). An identified mutation call alone never changes the task type; the status shows `editing` separately.

The resolved intent is cached per user entry key and reused through that entry's Pi tool loop. Router settle reminders (`[pi8-settle]`) and configured `syntheticPrefixes` never start a new entry.

---

## 2. Scoring (`scorer.ts`)

### Candidate expansion

Candidates are expanded per supported (model, effort) pair. One registry model may produce several routable candidates when bench rows exist at different effort levels — each with its own quality/cost/speed measurement. A supported level the source never measured is covered by an estimate stepped down from the nearest measured level above it, marked `qualityEstimated` (see "Effort estimation"). An `off` candidate exists only where a request at `off` runs the mode an `off` row measures: always for a non-reasoning model (its only serveable mode); for a reasoning model, only when its map does not set `off` to `null` and its provider can turn thinking off. `claude-bridge` cannot: it sends no effort, and Claude Code runs its default effort. `minimal` is never estimated: sources almost never measure it, and Codex, Anthropic adaptive thinking, and `claude-bridge` send it as `low`. A measured `minimal` row is kept. When all measured efforts are unsupported by the model's `thinkingLevelMap`, the model falls back to a single effort-less candidate.

### Effort estimation

Sources publish rows only for the effort levels they measured, so a fully serveable level (e.g. `sonnet-5:medium`) can have no row while `high` and `max` do. Such a level is estimated from the nearest measured level **above** it, minus a per-step quality drop; estimation is strictly downward, so nothing above the highest measured row is ever invented.

The per-step drop is derived from the store when candidates are built after a store change — the p90 of observed adjacent-level drops, computed per quality axis — rather than fixed. p90 rather than the median is the point: at the median an estimate lands above the true value roughly half the time, at p90 it under-shoots ~90% of the time, which is what lets an estimate compete for the pick at all. An axis with too few observations is left unestimated rather than extrapolated from noise.

Estimated rows carry price and context window (registry facts that hold across effort levels) but never `costPerTask`, speed, or latency — those are per-run measurements of one specific level. Estimated quality can meet ordinary minimums, but it cannot prove a strictly stronger model. AA-estimated indexes also carry `qualityEstimated`; exact knowledge/research values are never estimated across efforts.

### Capability tiers

Tier 0 meets every fixed minimum, tier 1 lacks a measurement but has no measured failure, and tier 2 fails a measured minimum. Every tier stays in the fallback chain. Price, speed, cache credit and compliance preference rank only inside a tier; they cannot buy a weaker model into tier 0.

| Task type | Required axes | Ranking axis |
|---|---|---|
| `lightweight` | none | intelligence |
| `gather` | intelligence ≥ 20 | intelligence |
| `plan`, `review` | intelligence ≥ 30, Omniscience ≥ 0, Briefcase rubric ≥ 0.35 | intelligence |
| `implement` | agentic coding ≥ 30 | agentic coding, then coding |

Coding-only implementations remain unknown, not measured weak. Omniscience is a signed closed-book correctness index; Briefcase rubric is the share of deliverable checks passed on work from many source files. The Omniscience hallucination rate is not a gate: its wrong-answer penalty is already in the index. Exact-effort knowledge and research are read at the effort delegation will serve. They are never inferred from a different effort or broadcast from an unlabelled row.

The table is calibrated on AA Intelligence Index v4.3 (2026-10-02), recorded as `CALIBRATED_INDEX_VERSION`. Sync reads `intelligence_index_version` from the API envelope and compares major.minor. A different or missing version is a warning, not a failure: the sync saves the new data and routing continues with the calibrated minimums. The warning shows at sync, at `router/auto` selection and in `/router-status`. A sync also warns when its strongest intelligence score differs by more than 15% from the calibrated reference.

An accepted handoff replaces each gated axis's minimum with `requirement × AXIS_REFERENCE[axis]`. Fixed reference strengths are intelligence 57.6, coding 78.3, agentic coding 56.5 and Briefcase rubric 0.61. Omniscience stays at zero. Quality above the handoff minimum earns no additional credit, so price and speed choose among suitable executors. Reference strengths do not depend on the request pool.

For context ≥ 64,000 estimated tokens, LCR correctness must be ≥ 0.30. Image requests need MMMU-Pro ≥ 0.30 as well as registry image support. Missing measurements become tier 1; measured failures become tier 2. These are capability judgements, not reasons to remove objective fallbacks.

### Cost and speed signals

Choose one scale per pick, from the tier-0 pool (or the filtered pool when no candidate meets all minimums). Cost uses `costPerTask` when more than half of that pool carries it; otherwise it uses blended registry `$/1M` (input × 0.25 + output × 0.75), with benchmark pricing as fallback. Free models without benchmark data earn no cost credit. Within each tier, lower cost gets logarithmic utility. The two scales are never mixed: on the task scale, a candidate without `costPerTask` gets no cost credit, whatever its `$/1M` price. Only the task scale tells efforts of one model apart, because they share one `$/1M` price.

Speed uses logarithmic time-per-task utility when more than half of the preferred pool carries it, otherwise registry output tokens/sec; on the time scale, a candidate without task time gets no speed credit. Lower-tier gaps never erase the preferred pool's task-cost or time coverage. Estimated rows carry neither task cost nor task time.

### Prompt-cache preference

The exact incumbent can keep the full conversation prefix. An effort change shares it only when the provider supports per-message effort; otherwise it receives only its own recently served prefix. Other warm candidates receive credit for their own prefix too. Credit is `min(warmTokens × (cacheWrite or input − cacheRead), switchMargin)` using the candidate's published cache prices. Missing prices earn no credit; subagent spawns receive none. Compaction, tree navigation or a changed system prompt/tool schema clears session prefixes.

After the two-week collection period, cross-session credit requires an identical prompt-head hash and the exact provider/model/effort key. Only the shared system prompt and tool prefix counts, never conversation tokens. Incremental hit estimates above background are 0.40 within five minutes and 0.30 within one hour; after an hour the credit is zero. These are conservative observational estimates, not guaranteed cache hits. Same-session events are excluded. Selection frequency never earns credit.

### Global protocol counts

`PI8_DIR/model-events.jsonl` stores small append-only records. Entry and session identities are opaque hashes. Compliance identity is one model release: it removes the provider and effort and treats `.`, `_` and `-` as one separator, but it keeps date and revision suffixes, so a new release does not get an older release's counts. Cache identity keeps both provider and effort. `served` and reminder records carry the routed task type, so fitted weights can control for workload mix. Reminder counts are kept per kind (`context`, `completion`, `contract`); the kinds are never added into one rate. A session reads the global history once per user entry, not on every tool continuation. Folding ignores malformed records, old rule versions and events older than 90 days. The append-only file is not rewritten during sync: rewriting while other sessions append could lose their records.

Entries and reminder episodes are deduplicated. A reminder outcome belongs to the model that received it; another model taking over or an interrupted continuation is not evidence of an ignored reminder. Counts decay with a 30-day half-life. Reminder-rate preference needs 30 effective entries; ignore-rate preference needs 10 completed episodes. Each uses a Wilson lower bound. The weighted penalty is capped by `switchMargin` and applies only within tiers.

`reputation` defaults to true. Unset `reputationWeights` means collection only for compliance; fit the weights after at least two weeks of observations rather than supplying fixture-derived defaults. Positive rewards for execution outcomes are not used. `/router-status` shows decayed counts and penalties; `/router-why` records a penalty that changed the preferred candidate. Every history read/write fails open.

### Effort

Each effort of a model is a separate candidate with its own score: a measured row, or an estimate stepped down from the nearest measured effort above it. The scorer therefore chooses the effort with the model, and the router serves the scored effort for every task type. There is no per-task effort table.

The router raises a scored effort only to the nearest level the model supports, with an **up-only walk** (`levelFrom`), and to the incumbent's minimum thinking level (`incumbentEffort`) for entries of the incumbent model. It never lowers a router-chosen effort.

The incumbent's minimum thinking level is the effort the incumbent actually served at, taken from the served key even when no row measures that effort. It applies to the pool before scoring, so the scorer compares the incumbent model at the effort that will serve: a lower effort is dropped when a row at the served effort exists. Otherwise the nearest lower row stands in at the served effort. That row reads knowledge, research, long-context, and vision reasoning only from a measurement retained at the served effort, or counts them as unknown; its other axes, price, and time stay at the lower effort's values. Delegation raises only an unlabelled entry of the incumbent model, which Pi's session level serves.

A candidate with no effort label gets Pi's session thinking level, as Pi sends it when a user selects that model; Pi does not choose an effort itself. When no level is sent, a provider turns thinking off, or, where it cannot (`off: null`, `claude-bridge`), the model runs at its default effort. An explicit user thinking level wins over both and uses a nearest-first walk (`resolveThinkingLevel`) to honour the user's choice as closely as the model supports.

---

## 3. Delegation fallback loop (`delegation.ts`)

The loop walks the ranked fallback chain (each entry is a `provider/id:effort` key) and streams the first candidate that produces meaningful output.

Provider availability is only resolved at stream time. Registry auth-filtering is per-provider, not per-model, and the per-attempt credential check is the real gate — an authenticated provider can still 421/hang/error on a specific model. The fallback chain absorbs the failure, but the first attempt's latency is already spent.

### Session-scoped manual pin

`/router-manual [provider/model[:thinking]|resume]` leaves `router/auto` as Pi's active model and stores the pin only in `RouterSession`; `reset()` clears it. A manual turn skips the assessment dispatch, restricts scoring to the pinned model's candidates, records cause `manual-override`, and truncates the fallback chain to the chosen effort variant. Delegation therefore has one model in its chain: failure is surfaced rather than substituting another model (ordinary same-model retry policy still applies).

A thinking-level change the router did not write (Shift+Tab, settings, or another extension's `pi.setThinkingLevel`) also sets a pin: the model that served the previous invocation, at the new level clamped to what that model supports. An existing pin moves to the new level. Pi's `thinking_level_select` carries no source and also fires for the router's own footer sync and for model switches, so the router detects the change at the next provider invocation instead: it compares `options.reasoning` with the level Pi held right after the router's last sync (`syncedThinkingLevel`). A switch to `router/auto` clears that baseline. Before any model has served, the change stays a one-turn effort override.

`/router-manual resume` leaves manual mode and reuses the pre-pin route. Setting the first pin snapshots the auto decision then in effect (`resumeSnapshot`); `resume` schedules that snapshot and discards pin-owned pending trajectory escalation so automatic routing does not act on stale evidence. The next router turn serves the snapshot's chosen model and fallback chain directly — no classification, assessment, or scoring — under cause `resume`, filtered to the still-routable chain entries (an empty result falls through to ordinary routing). The one-shot is scoped to a single user entry by `resumeIntentKey`: same-entry tool-loop continuations reuse it, the next entry expires it and recomputes. When no pin (or scheduled snapshot) is active, `resume` is a no-op.

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

Each chain entry carries its own effort from the bench row. Router-chosen efforts are resolved via up-only walk (`levelFrom`); an entry of the incumbent model is raised to `incumbentEffort`. Explicit user reasoning requests use nearest-first walk (`resolveThinkingLevel`) so the user's choice is honoured as closely as the model supports.

### Post-content irreversibility

Once visible text or a tool call has streamed, the router never replays on another model — that would duplicate output or side effects. A later error is reported to the stream instead.

---

## 4. Subagent routing

### Role injection

pi-subagents roles (`researcher`, `planner`, `worker`, `reviewer`, `advisor`) each provide a minimum dimension via `ROLE_DIMENSIONS`. The router builds and auth-filters the candidate snapshot during session refresh, then re-scores each visible structured child at spawn time from its role; configured dimension weights and the live context guard apply to that pick before the concrete `provider/model` is injected through the `tool_call` hook. Workflow-script children are opaque to the structured walker, so those calls retain the worker-first tool-level default (worker → planner → researcher → advisor → reviewer) rather than task-aware per-child routing. A per-child `model` inside the script still wins, and scripted failures remain ordinary tool errors. Reviewer children are kept independent from the selected worker's model family.

Nothing is written to `settings.json` — injection is per-spawn only. Explicit model choices and user/project pins (`source` ≠ `pi8`) always win. A concrete child cannot switch models mid-process.

### Usage-limit exclusion

A foreground child that fails with a provider usage-limit error (quota/billing/subscription cap, matched by `isUsageLimitErrorMessage` — the same classifier the main stream uses) excludes that whole provider for the session, so later spawns and main turns skip every model on it (rule 8: the cap is shared provider-wide). Per-attempt errors attribute the cap to the exact model. This is the only non-retryable child failure that persists: transient errors are retried by pi-subagents/the model, and request-specific failures (invalid request, refusal) say nothing about provider health. The router never retries or respawns the child — recovery is the parent's decision.

### Provider auth filter

Before subagent role assignment, a per-provider credential probe (timeout 3s) filters out unauthenticated providers. Without this, a pick-once subagent spawn naming an unauthenticated provider would hard-fail. A total probe failure means authentication is unknown, not known-successful — no injection occurs.

---

## 5. Escalation mechanisms (2 distinct paths)

### 1. Objective trajectory escalation
Objective trajectory friction (repeated action/observation, persistent verifier failure, confirmed stagnation, pre-output reasoning loops) sets a pending same-dimension quality-first repick for the next provider invocation, or hops immediately when replay is still safe. Models do not self-escalate; `commit_execution` hands work down, and the router decides the executor (§6).

### 2. Main-stream automatic fallback
The delegation loop reacts only to objective pre-answer failures. No semantic-quality inference, no replay after visible output, a tool call, or a thinking-overflow commit.

---

## 6. Final step and execution contracts

### Final step and capability band (`work-phase.ts`)

A ready `hand_off_context` or `reopen_work` declares the final step: `kind` (the deliverable), `complexity` (`trivial`|`routine`|`moderate`|`hard`|`frontier`), and `scope` (`bounded`|`open-ended`). Within an entry a stronger declaration replaces a weaker one, never the reverse (`withStrongerTerminal`).

```
requirement = clamp01(KIND_BASE[kind] + 0.5 × COMPLEXITY[complexity] + (scope === 'open-ended' ? 0.1 : 0))
```

| Band | Requirement | Minimum |
|---|---|---|
| `economy` | < 0.30 | none |
| `standard` | < 0.50 | 0.45 |
| `strong` | < 0.75 | 0.70 |
| `frontier` | ≥ 0.75 | 0.85 |

The band only raises minimums: a plan or review handoff takes the higher of its rubric requirement and the band minimum. A `gather` entry whose final step is `strong` or `frontier` gets its one `hand_off_context` reminder on its first tool result rather than its first edit.

### Execution contract (`execution-contract.ts`, `execution-contract-tool.ts`)

The explicit `plan`/`review` → `implement` handoff. The serving model calls `commit_execution` with the remaining work as a closed program: `edit`/`create` steps (path and exact change), `delete` steps, and `verify` steps (`test`/`typecheck`/`lint`/`build`), at most 12 steps, no glob paths. The router's five tools (`commit_execution`, `hand_off_context`, `routing_context`, `complete_work`, `reopen_work`) are registered once and declared for every session model: `session_start` and `model_select` add any missing name with `pi.setActiveTools()` and keep every other active tool. A set that already holds them is not set again. A change of the tool set changes the prompt head and loses the provider's cached prefix, so a switch between `router/auto` and a concrete model changes only the tools note (`router-tools-note.ts`). Each tool description starts with "Call this tool only when the latest router note says that the router tools are on." A `router/auto` request carries the note "Router: The router tools are on.", and a request to another model carries the off note, which names the five tools and tells the model not to mention the router, its tools, or the note to the user. A tools note is added only when the request's latest tools note gives the other state or its message is no longer in the request. The tools still refuse calls outside `router/auto`. It declines without state changes outside `router/auto` or outside a `plan`/`review` decision. Guidance that lives only in the prompt head is easy for a model to lose in a long context, so under the same conditions the result of the entry's first native `edit`/`write` without a plan gets one appended reminder to consider the tool. Appending to a tool result keeps the transcript prefix and prompt cache intact; each reminder is logged as a `reminder` record, so reminders without a later `accept` count missed handoffs.

The router, not the model, values the plan (`execution-difficulty.ts`). The submitter only describes the remaining work: `remainingWork` rates five criteria from 1 (easiest) to 5 (hardest) — open decisions, spread, verification, knowledge needed beyond the listed files, and coupling. A model asked whether work is easy tends to answer confidently whatever the truth; a description on fixed scales, weighted by the router, can be checked against outcomes and refitted. The requirement is 30% plus a lookup on open decisions (level 5 alone reaches 90% and keeps the submitter), up to 8 points per other criterion, and up to 4 points per measured fact: files, directories, existing lines of the edit/delete targets, and fix commits touching the targets in the last 180 days (`git log`). An unscored criterion counts as level 5; a failed measurement counts halfway, so neither lowers the requirement. Commits, test targets, and step count are logged but not weighted. The requirement maps to a band (`economy` < 45%, `standard` < 70%, `strong` < 85%, otherwise the submitter keeps the plan). The plan's shape only raises that band: more than 2 files or 4 steps needs `standard`, more than 5 files or 8 steps keeps the submitter, and so does an edit/delete target that does not exist. Each executor model already excluded in the task raises the band one step. A releasing band routes the next invocations as `implement` with the implementation minimum set from the fixed agentic reference, and both incumbent minimums are skipped so a cheaper executor can win on score. A contract that keeps the submitter still routes as `implement`, with both incumbent minimums in force. The weights are hand-set; every contract logs its rubric, measurements, and outcome so they can be fitted instead.

A contract is executed when a native `edit`/`write` has succeeded on every declared edit/create target, or when its executor has used `2 × steps + 4` provider invocations (Bash writes and deletions are never attributed, so the budget ends such plans). The executor is the first model other than the submitter that serves an invocation of a released plan. A released plan can still be served by its submitter alone: it may win on score, or serve as a fallback. A plan another model executed routes the rest of the entry as `review` with the submitter as the incumbent and its task type as the thinking minimum: a finished plan can be wrong in ways no break detects, and only the submitter can judge the work against its intent. Switching on the invocation after the last declared edit is the only point the router can guarantee: once a model answers with text alone, Pi's loop ends and no invocation remains to hand back. Verify steps after the last declared edit therefore run under review. A plan only its submitter served continues as `implement`. The first verifier run after execution is recorded as `pass`/`fail`. A new `commit_execution` during review is **rework**: it strikes the executor like a break, and the revised plan keeps the original task type. The contract ends with its entry — when Pi's run settles, or when a queued entry starts — and is labelled `clean` (no edits during review), `fixed` (the submitter edited), `rework`, `broken`, or `unfinished` (still active); one `outcome` record is logged.

The contract breaks when the executor edits (native `edit`/`write`) a file outside its declared targets, calls `commit_execution` again, or sets a pending objective trajectory handoff. The breaking call is never blocked: reading files, running commands, and Bash writes are not attributed to a target. The next invocation routes at the submitter's task type with the submitter as the incumbent and its task type as the thinking minimum; a pending trajectory handoff still owns that pick. The contract is then cleared and the submitter may submit a revised plan. Each executor model gets two strikes (breaks or reworks) per task; after the second it is excluded at every effort and on every provider, and later executors must also have measured implement quality strictly above the strongest excluded executor, so repeated handoffs end at the submitter after at most three exclusions. Strikes and exclusions carry to later entries on the same work item, including a reopen of it; an active contract does not.

### Decision surfacing

`/router-status` and `/router-why` (`formatDecisionDetail` in `ui.ts`) print the task type and its cause. A decision can display `editing` after an identified mutation call; its task type changes only through an accepted handoff or execution contract, whose state `/router-why` prints on the `plan:` line — band and executor minimum, why the submitter keeps it, who executed it, or why it broke — and `excluded:` once an executor model is excluded.

---

### Work completion and the entry after it

Work-item lifecycle is independent of task type and execution-contract state. `complete_work` appends `work-close` and a `work-complete` boundary in one `context-commit`, before updating entry-local completion state. It only affects the active item and rejects `done` while an execution contract is active or broken. Supersession does not claim the contract was executed.

  Requests the router did not serve are read from the branch (`requestRouting`). A request is served when the latest model selection recorded before it is `router/auto`, or when a router event names it. Pi records `/model` switches as `model_change`; for a model Pi does not record (resume with `--model`, `/tree` onto a branch recorded with another model), the router writes a `pi8-model-selection-v1` entry in `before_agent_start`, before Pi stores the request, read like `model_change`. Opening a session or moving with `/tree` writes nothing until a request is sent. Such a request ends the active item in the fold: the next routed entry collects context and chooses again, and the item stays open. A switch with no request sent under it keeps the active item; the incumbent ends at any switch to another model. Every request the router did not serve, before tracking began or in a later stretch under another model, is indexed for lexical search (`legacy.ts`) and offered as an `l_n` choice. The index covers the path to the last such request, so it is built again only when a new one is sent. Stored `migration-init` records are read as applied events that keep no state; the router does not write them.

  The incumbent stores the work item it served and survives completion. With no active item, `completedIncumbent` identifies a `done` item still associated with that model; the next entry receives a `priorCompletion` marker. The model may answer about the completed work directly. A separate completed-work gate blocks detected mutations, `commit_execution`, and subagents without counting acquisition refusals. A valid handoff clears the marker. Selecting a done item derives relation `reopen` from its prior status and writes the reopen transition; selecting different work leaves the completed item unchanged. A handoff that selects the completed item the entry owns (completed before this entry, or earlier in it) is refused without counting a refusal and points to `reopen_work`, so that item has one reopen protocol. A fallback that serves that entry retains the same work-item association. `reopen_work` is the shortcut for that same item: it takes no work-item id. It checks the entry is still current, grounds referenced files the same way a handoff does, and appends the reopen transition in one commit. Acceptance sets a pending handoff so the router may repick once, and records the incumbent on the reopened item.

  Router notes (the context-collection note, the clarification note, and the active and completed work notes) are added to message content in the request, never to system sections. A provider caches a request by its prefix, so a sent note stays on the same message with the same bytes in every later request (`request-notes.ts`). A new note goes on the last message of the request. It is recorded as a `pi8-request-note-v1` custom session entry with its anchor (the message timestamp, or the tool call id of a tool result), so it follows `/tree` and forks and never reaches the model by itself. A note is not replaced: a different instruction for the same request is a new note that starts with "Do not follow the earlier router notes for this request." Requests to every session model carry the recorded notes, so a model switch keeps the prefix: a Pi `context` handler adds them to requests to a concrete model, together with the tools note. A concrete-model request adds no entry note. `complete_work` and `reopen_work` are registered once and execute sequentially so later tool calls in their batch see the new status. `agent_before_settle` appends at most one hidden reminder per entry and kind, and continues once. While the entry collects context and declared nothing, the reminder asks for `hand_off_context` when the router has refused a handoff or a call from it, or when the entry's task type is not `gather` or `lightweight`: a plan, review, or change written while collecting context skips that task type's minimum. A direct answer to a `gather` or `lightweight` request with no refusal, or an answer declared through the tool, settles as it is. Otherwise, when the entry's execution contract is executed, the entry changed files without a contract, or a model served its `plan` or `review` handoff with no contract (the reply is the requested work), and `complete_work` was not accepted, the reminder asks for `complete_work`. The context reminder comes first; no completion reminder runs while context is still being collected. Pi computes the event's `canContinue` before any entry is added, so it is false right after a final reply; the router does not check it, and Pi checks the context again after applying the entries. The router appends its entry to the drafts of earlier handlers, because a handler's entries replace them. The reminder starts with `[pi8-settle]`, which turn classification always excludes, so the continuation keeps the entry's intent key, and `withGatheringNote` keeps its note on the entry's own message. A second settle of the same kind, an error, or an abort does not continue. Each reminder logs a `settle-reminder` work-lifecycle record with its kind (`context` or `completion`). `agent_settled` logs once per entry whether each reminder was followed — any accepted `hand_off_context` outcome (ready, declared answer, or `needs-user`), or an accepted `complete_work` — as `settle-followed` or `settle-ignored`, and closes the entry's logs. It changes no work state. No `replyPending` state is needed: tool-result continuations retain the intent key. Direct answers stream immediately without a declaration-triggered retry; failed-attempt buffering and the no-replay-after-visible-output rule remain independent of work lifecycle.

## 7. Data flow

### Benchmarks

The **Artificial Analysis** Data API (free tier, `x-api-key` header) and public models page form one benchmark source. The page is read in headless Chromium using `playwright-core`, capturing its decrypted models payload. Chromium is a prerequisite of `/router-sync` only; the install command names the exact resolved CLI. Serving reads the persisted store, so a missing browser is a warning at `router/auto` selection and in `/router-status`, and the current data stays in use. Automatic turns require a synced store that includes models-page measurements (`checkBenchmarkStore`); without one, selection shows an error and the provider emits one terminal setup error before delegation. Pi hooks cannot refuse the model selection itself. Manual pins and concrete-model sessions are not checked. Scrape failures keep the previous store. The page adds Omniscience, Briefcase rubric pass rate, LCR, MMMU-Pro, task time and the estimated-index flag to each API row by `(slug, parsed effort)`.  Rows carry `evaluations` (intelligence, coding, agentic indices), `pricing` ($/1M input/output), and `performance` (tokens/sec, TTFT, TTFA). Quality coverage is bounded by what Artificial Analysis publishes: a model with no matched row carries no quality signal and routes on registry metadata alone.

**Effort labels** are parsed from the model name parenthetical: `GPT-5.6 Luna (low)`, `Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)`, `DeepSeek V4 Flash (Non-reasoning)` → `off`. The first recognized comma segment wins, including labels followed by "Default Fallback" or provenance text. The parse fails closed (unrecognized → undefined).

**Run variants**: AA re-runs benchmarks under different configurations, suffixing slugs with `-<4 digits>` (e.g. `gpt-5-6-luna-low-1234`). These are stripped via an explicit variant list in `matcher.ts`. The variant list is explicit rather than a general stripping rule because generic suffix-stripping corrupts real model identities like `qwen3.7-max`.

**Store format**: identity is `(registryId, effort)` — NUL-separated in storage, `provider/id:effort` in candidate keys. v2 stores discard v1 stores with a single warn line. API and site refresh as one transaction; either failing preserves the previous store. The store also retains the AA index version when reported. When several AA rows resolve to one `(registryId, effort)` (for example a preview and its release), one whole row is kept: measured before estimated, then the row with the most quality axes. Axes are never combined from different rows, because the result would describe a model that nobody measured.

### Fuzzy matching

Benchmark slugs are fuzzy-matched against Pi's live registry model IDs. Manual overrides are available via `/router-fix` when matching fails; until an override lands, the unmatched model has no quality data and routes on registry metadata only.

### Session state & lifecycle

Routing state is encapsulated into instantiable domain aggregates:
- `RouterSession`: Root session container owning session generation, last decision/served model, candidate expansion cache, and domain sub-objects. Cleared on `session_start` or test resets.
- `BlacklistState`: Encapsulates model and provider runtime exclusions, as well as session glob patterns with case-insensitive normalization.
- `IntentState`: Manages cached routing intent across tool loops and the entry's work-phase state.
- `RuntimeBindings`: Stores Pi's `ExtensionContext`, active `modelRegistry`, and provider registration signature. Persists across `session_start` resets and clears only on extension shutdown or reload.

### Decision log

Append-only per-session sidecar next to the Pi transcript (`<session-dir>/<timestamp>_<sessionId>.router-decisions.jsonl`; ephemeral sessions without a persisted session file share `~/.pi/agent/pi8/decisions.jsonl`): dimension, chosen model, cause, fallback chain, capability-gate diagnostics, `investigation-handoff` records (context handoffs), `work-lifecycle` records, and `execution-contract` records (accept/reject/break/reminder/execute/outcome with band, executor minimum, rubric levels, measured counts, outcome label, reject code, and model keys; never plan paths or change text). Cause values: `heuristic`, `continuation-context`, `router-consult`, `execution-contract`, `investigation`, `investigation-handoff`, `incumbent`, `work-context`, `error-fallback`, `no-data`, `capability-escalation`, `trajectory-escalation`, `self-healing-gap`, `manual-override`, `resume`, `semi-hold`. Readers still accept causes that older records carry.

### Timing log

Per-step millisecond timing (opt-in via the `debug` config): registry wait, scoring, per-candidate auth/stream attempts, turn totals. Written as a per-session `*.router-debug.log` sidecar (`/tmp/pi8-debug.log` when ephemeral).

---

## 8. Configuration reference

Options in `~/.pi/agent/pi8/config.json`:

| Key | Default | Description |
|---|---|---|
| `artificialAnalysisApiKey` | — | Saved by `/router-sync` |
| `models` | `[]` (all) | Allowlist: provider/id glob patterns (`*` wildcards, case-insensitive; a bare provider name means `provider/*`) |
| `blacklist` | `[]` | Persisted exclude patterns, same syntax as `models` |
| `prompt` | `true` | TUI notification on model switch |
| `semi` | `false` | Ask before switching away from the last served model |
| `switchMargin` | `0.15` | Cap on prompt-cache credit and protocol penalty; `0` disables both |
| `routerContextWindow` | served model's window | Context window advertised for `router/auto`. Pi tunes compaction to it, so `router/auto` advertises the window and output limit of the model that last served, and the largest routable window before any model has served. A lower value makes Pi compact earlier and keeps smaller-window models eligible longer. Values above the default are clamped to it. |
| `debug` | `false` | Timing log path or `true` |
| `syntheticPrefixes` | `[]` | Literal prefixes marking synthetic messages |
| `dimensionWeights` | per-dimension defaults | Override `{quality, cost, speed}` per dimension |
| `reputation` | `true` | Collect global model counts, use exact-prefix cross-session cache credit and configured compliance preference |
| `reputationWeights` | unset | `{reminder, ignored}` nonnegative weights in [0, 1]; unset keeps compliance collection only. Fit from at least two weeks of observations |
| `baselineModel` | — | Model `/router-report` compares routed spend against |

---

## 9. Non-goals

- Semantic answer grading or automatic retries on perceived quality
- Replaying after visible text or a tool call, or replacing a running child in-place
- Rewarding popularity or remembered execution quality: execution-contract outcomes are logged for offline fitting; only within-task rework strikes and configured protocol-compliance preference affect runtime choices
- Acting as a model gateway/proxy for non-Pi tools

---

## 10. Development

```bash
npm run tsc
timeout 120 npx vitest run
```

Core modules:
- `scorer.ts` — pure scoring, `pickBest`, capability tiers, effort resolution (no I/O)
- `delegation.ts` — fallback loop: auth, retries, circuit breaker, timeouts
- `provider.ts` — orchestrator: registry wait, entry phase and escalation, score, delegate; also owns `buildSubagentProviderAuthFilter`, the 3s per-provider credential probe
- `index.ts` — hook wiring; runs the credential probe before role assignment
- `adapters/` — benchmark data sources (`artificial-analysis.ts` joins API rows with `artificial-analysis-site.ts`)
- `subagents.ts` — role injection (no probe of its own)
