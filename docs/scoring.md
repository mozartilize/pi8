# Scoring

[Overview](overview.md) · [Routing](routing.md) · [Architecture](overview.md#architecture)

The scorer selects a model and its effort together. Capability tiers precede quality, cost, speed, cache credit, and protocol preference.

## Candidate expansion

Candidates use `provider/id[:effort]` identities. Each supported, measured effort produces a separate candidate with its own measurements.

Delegation calls `modelRegistry.streamSimple`. Providers that reject bare delegated calls are not automatic candidates.

For example, the Cursor SDK accepts requests only from its owning session. Pi can still select a Cursor model as a concrete session model.

An unmeasured supported effort can receive an estimate from a higher measured effort.

`off` requires a provider mode that actually disables thinking:

- A non-reasoning model has only this mode.
- A reasoning model needs a supported `off` mapping and a provider that can disable thinking.
- `claude-bridge` cannot disable thinking. Without an effort, Claude Code uses its default effort.

The router never estimates `minimal`. Several providers map it to `low`, so an invented measurement would not identify a separate mode.

A measured `minimal` row remains available when supported.

If the model supports none of its measured efforts, it receives one candidate without an effort label.

## Downward effort estimates

An estimate starts at the nearest measured effort above the requested level. It subtracts one conservative quality adjustment per level.

The adjustment is the 90th percentile of observed adjacent-level decreases on each quality axis.

The router calculates these adjustments when candidate construction follows a store change. An axis with insufficient observations remains unestimated.

The router does not estimate above the highest measured effort.

Estimated rows retain registry price and context metadata. They do not inherit task cost, speed, or latency measurements from another effort.

Exact knowledge and research measurements never transfer across efforts. An unlabelled row does not supply them to a named effort.

Estimated quality can satisfy ordinary eligibility. It cannot prove a strictly stronger model for escalation or excluded-executor replacement.

## Capability minimums and ranking axes

See [Routing](routing.md#default-capability-minimums) for the default eligibility table.

Under `legacy`, ranking uses Intelligence for lightweight, gather, plan, and review work.

Implementation ranking normally uses agentic coding, then coding. An explicit implementation requirement below 0.45 uses the AA Agentic Index instead.

Cross-model capability comparisons and escalation do not use the AA Agentic Index under `legacy`.

Coding-only rows remain unknown for implementation eligibility. A missing agentic measurement does not establish measured weakness.

Omniscience can be negative. Its incorrect-answer penalty is already part of the index, so hallucination rate is not a separate minimum.

## Requirement references

An accepted requirement scales the required task axes against fixed reference strengths:

```text
axis minimum = requirement × axis reference
```

| Axis | Reference strength |
|---|---:|
| Intelligence | 57.6 |
| Coding | 78.3 |
| Agentic coding | 63.6 |
| AA Agentic Index | 57.9 |
| Briefcase rubric | 0.61 |

Omniscience remains at zero. Long-context and image minimums remain separate input-shape constraints.

Reference strengths do not depend on the available pool. Quality above an accepted handoff minimum earns no additional credit.

See [Work lifecycle](work-lifecycle.md#requirement-formulas) for the rubric and final-step formulas.

## Cost scale

Each selection uses one cost scale. Coverage comes from tier 0, or the filtered pool when no candidate meets every minimum.

If more than half of that pool has `costPerTask`, the selection uses task cost.

Otherwise, it uses blended registry token prices, with benchmark prices as fallback:

```text
blended price = input price × 0.25 + output price × 0.75
```

Lower cost receives logarithmic utility within its capability tier.

On the task-cost scale, a candidate without task cost receives no cost credit. Its token price cannot replace the missing measurement.

Free models without benchmark data receive no cost credit.

Task cost can distinguish efforts of one model. Registry token prices normally cannot, because those efforts share a price.

## Speed scale

If more than half of the preferred pool has task duration, the selection uses logarithmic task-time utility.

Otherwise, it uses output tokens per second.

A candidate without task duration receives no speed credit on the task-time scale.

Missing lower-tier measurements do not reduce the preferred pool's coverage. Estimated rows carry neither task cost nor task duration.

## Same-session cache credit

The exact incumbent can retain the full conversation prefix.

An effort change shares that prefix only when the provider supports per-message effort. Otherwise, it receives only its own recently served prefix.

Other recently served candidates can receive credit for their own prefixes.

Credit uses the candidate's published cache prices. It multiplies reusable tokens by the cache-read discount, then caps the credit at `switchMargin`.

The discount uses cache-write price when available, otherwise input price. All prices use the same token unit.

Missing cache prices receive no credit. Subagent spawns receive no cache credit.

Compaction, tree navigation, and changes to the system prompt or tool schema clear session prefixes.

## Cross-session cache credit

Cross-session credit starts after at least two weeks of history collection.

It requires:

- An identical prompt-head hash.
- The exact provider, model, and effort identity.
- A recent matching record from another session.

Only the shared system prompt and tool prefix count. Conversation tokens do not.

| Age | Incremental cache-hit estimate |
|---|---:|
| Up to five minutes | 0.40 |
| More than five minutes, up to one hour | 0.30 |
| More than one hour | 0 |

These values are observational estimates, not guaranteed cache hits. Selection frequency earns no credit.

## Protocol preference

Protocol preference uses independent reminder and ignore rates, not execution-success bonuses.

Counts decay with a 30-day half-life. Reminder-rate preference needs 30 effective entries. Ignore-rate preference needs 10 completed reminder episodes.

Each rate uses a Wilson lower bound. Configured weights determine the penalty, capped by `switchMargin`.

Unset `reputationWeights` leaves compliance collection active without a compliance penalty.

See [Observability](observability.md#protocol-history) for record identities, retention, and deduplication.

## Served thinking effort

The scorer chooses an effort for every task type. No task-specific effort table replaces that choice.

`levelFrom` raises the selected effort to a supported level. It never lowers the selected effort.

The incumbent's minimum thinking level comes from the effort actually served, even if no benchmark row measures it.

Before scoring, the router removes lower incumbent efforts when a row at the served effort exists.

Otherwise, the nearest lower row represents the incumbent at the served effort.

That row retains its other quality, price, and duration values. Knowledge, research, long-context, and vision measurements require the served effort or remain unknown.

An unlabelled candidate uses Pi's session thinking level. Without a sent level, the provider disables thinking or uses its default when disabling is impossible.

An explicit user choice uses Pi's nearest-supported resolution. The user choice is distinct from the router's up-only resolution.

## Incumbent minimums

Ordinary tool-loop invocations retain both incumbent capability and thinking minimums.

The router skips these minimums at these boundaries:

- A released execution plan.
- Another accepted handoff, until a model serves the new phase.
- An applied trajectory handoff.
- The start of a `new`, `resume`, `switch`, or `reopen` entry.

A retained plan keeps both minimums. A fallback candidate can serve without satisfying the declared boundary.

A boundary remains pending until a qualifying candidate serves. A higher supported effort of a qualifying candidate also satisfies it.

## Evaluation comparator

`cheapest-sufficient` uses Intelligence for implementation selection and all cross-model strength comparisons.

Excluded-executor replacement needs measured superiority over every excluded source at the effort that will serve.

Unknown or estimated cross-model quality cannot prove replacement. Without proof, the submitter retains the guarded plan.

A supported higher effort of the same model remains a stronger move without cross-model benchmark proof.

Recovery retains the complete required vector and captured policy. It tiers the complete proven-stronger set before cost preference.

Unknown and insufficient entries remain available as recovery fallbacks. Ordinary provider-error fallback remains available too.

See [Routing](routing.md#evaluation-comparator) for defaults and validation limits.

[Scorer source](../extensions/routing/score/scorer.ts)
