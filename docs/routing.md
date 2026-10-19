# Routing

[Overview](overview.md) · [Glossary](glossary.md)

## Pipeline

```text
Saved benchmark data + Pi registry
                 |
       Resolve the task type
                 |
       Expand model and effort candidates
                 |
       Compute features and uncertainty intervals
                 |
       Reject malformed numerical actions
                 |
       Rank valid authorized actions in one pool
                 |
       Delegate with a fallback chain
```

The router runs in Pi's process. It does not call a separate classifier or assessment model.

Each model call serves the user's request.

## Task types

| Task type | Purpose |
|---|---|
| `lightweight` | A direct, simple answer or side question |
| `gather` | Context collection and investigation |
| `plan` | Reasoning about a proposed course of work |
| `implement` | Authorized changes |
| `review` | Examination of work against its requirements |

With no incumbent, a request starts as `gather`. An accepted declaration establishes the next task type.

The incumbent retains its task type until an accepted boundary changes it. A mutation call alone does not change `plan` or `review` to `implement`.

Simple implementation remains `implement`. It does not become `lightweight` because the edit is small.

See [Work lifecycle](work-lifecycle.md) for the declaration tools and execution plans.

## Capability targets

Each relevant axis has a demand `D` in [0, 1]. Zero means easy. One means extremely hard or unresolved requirements. A rubric gives an axis-specific demand. Declared complexity gives an interval when no rubric is available. With neither declaration, demand spans `[0, 1]`, with central value 0.5; that value is not a measurement.

Targets use absolute benchmark scales. They do not depend on which models are in the pool.

| Axis | Normalized quality | Target at D=0 | Target at D=1 | Shortfall scale |
|---|---|---:|---:|---:|
| Reasoning | Intelligence / 100 | 0.20 | 0.55 | 0.15 |
| Agentic coding | Terminal-Bench 4.0 percent / 100 | 0.01 | 0.60 | 0.20 |
| Research | 0.75 × Briefcase + 0.25 × (Omniscience + 100) / 200 | 0.25 | 0.65 | 0.20 |

The target interpolates linearly between its endpoints. These endpoints and shortfall scales are authored policy, not measured task-success thresholds.

For quality `q`, target `t`, and shortfall scale `w`, capability fit is `clamp(1 − max(0, t − q) / w, 0, 1)`. Surplus capability earns no extra fit. Phase relevance multiplies this fit; demand does not change relevance or price sensitivity.

The lower fit uses lower quality and upper demand. The upper fit uses upper quality and lower demand. The central fit uses both central values. Exact minimax regret uses `upperFit(competitor) − lowerFit(candidate)` over the preference weight domain. These independent intervals form a conservative envelope; they do not claim that each action faces a different task. A full unknown-demand interval can still favor stronger models. A supported upper bound removes demands above that bound from the comparison.

## One comparison pool

Permission, technical guards, and numerical validation decide which actions may serve. Every action that passes them enters one comparison pool. Exact minimax regret ranks that whole pool. When exact selection is not available, a central fallback ranks the same pool with one weight vector. The decision records which method ran. Central fallback is not minimax regret.

Capability enters the comparison only as features. An action below a target gets a lower capability fit. The preference weight domain decides how much that fit counts against price, speed, and continuity. Two actions whose fits on an axis both clip to zero have the same feature value on that axis, whatever their shortfalls.

Missing quality evidence is uncertainty, not a reason to rank an action last. Missing and source-estimated quality use the full `[0, 1]` interval. With equal bounds and other features, they have the same exact regret. Their central fallback scores can differ because their central values differ.

Malformed feature vectors, non-finite predicted costs, and duplicate action keys are numerical errors, not low utility or missing quality evidence. The router records their keys in `invalidActions` and excludes them from ranking, context preparation, and provider fallback. If every action is invalid, selection returns `no-feasible-action` with reason `invalid-features` and starts no provider request. A saved route is ranked again if one of its actions fails numerical validation.

Exact decisions record `regretScope: pool`. Their regret values are comparable across all ranked actions. A record without this marker can contain regret values that are comparable only among actions of equal shortfall.

## Diagnostics

The selector also computes `max(0, (lowerTarget − upperQuality) / shortfallScale)` for each relevant axis and logs the largest value as `capabilityShortfall`. It also lists the actions that lack evidence for the phase's required axes. These values explain a decision. They never filter, group, rank, or break ties.

A zero shortfall means the available evidence establishes no deficit; it does not certify task success. Unknown and source-estimated quality cannot establish a deficit from their central estimate alone.

Axes with zero phase relevance do not contribute a shortfall. Vision and long-context evidence rules remain separate from these three targets.

## Collecting context

Collecting context is not the same work as a `gather` deliverable. The host marks a decision as collecting context only when all of these are true: the routed task type is `gather`, the entry is collecting context with read-only tools, and the model has not declared a direct answer. The model's prose cannot set this mark.

The one clarification request also has this mark. After `needs-user`, or when the request budget is used up, the reply only asks the user for the missing information, without tools. The deliverable's demand does not apply to that reply.

While collecting context:

- The reasoning target is 0.20, whatever the deliverable's demand. Unknown deliverable demand stays unknown in the evidence.
- Reasoning relevance does not change. Observed open decisions still raise it.
- Research and knowledge quality give every action the same `researchFit` value, 0.5, and no shortfall.
- Intelligence is the required evidence, not Research. Long-context and vision evidence rules still apply.

The mark ends at an accepted handoff or a declared direct answer. A `gather` answer, and every plan, review, or implementation phase, uses the targets above. The 0.20 target is authored policy. It is not a measured minimum for the quality of collected context.

An investigation is not collecting context. When the answer needs one, for example the cause of a bug, the collecting model hands off with outcome `ready`, deliverable `gather`, and a reasoning rubric. The router then selects the investigator with the rubric's demand, as for a plan or review. A handoff without a rubric uses its declared complexity bounds. A direct answer retains its reasoning rubric or complexity bounds for the next gather invocation; it creates no work item or handoff. Only an entry that is collecting context can hand off to `gather`.

## Difficulty declarations

An accepted handoff or execution plan supplies demand only for its target phase. Each rubric level maps to `(level − 1) / 4`. Independent requirements use their maximum, not an average.

| Rubric | Reasoning demand | Agentic demand | Research demand |
|---|---|---|---|
| Implementation | max(openDecisions, knowledge, coupling) | max(openDecisions, spread, verification, coupling) | max(openDecisions, knowledge) |
| Plan/review | max(alternatives, stakes, knowledge, uncertainty) | max(spread, stakes, uncertainty) | max(knowledge, uncertainty) |

File measurements supplement agentic demand, capped at one. File count, directory count, existing lines, and fix commits each add at most 0.05. Their full contributions occur at five files, four directories, 4,000 lines, and five fixes. Lines contribute nothing through 250, then increase logarithmically. A failed measurement adds its maximum. Evidence that is not applicable adds nothing.

A rubric takes precedence over complexity, including when a low complexity label conflicts with a difficult rubric. Missing rubric criteria inherit the highest supplied level. Without a rubric, complexity supplies these authored bounds on each axis:

| Complexity | Lower | Central | Upper |
|---|---:|---:|---:|
| trivial | 0 | 0 | 0.125 |
| routine | 0.125 | 0.25 | 0.375 |
| moderate | 0.375 | 0.5 | 0.625 |
| hard | 0.625 | 0.75 | 0.875 |
| frontier | 0.875 | 1 | 1 |

Each band extends half a rubric step around its central value, clipped to `[0, 1]`. These are policy bounds from a declaration, not measured confidence intervals. File measurements add to the agentic center and both bounds, capped at one. An open-ended scope keeps the agentic upper bound at one when there is no rubric. A small file set does not reduce a declared demand. Direct answers measure the union of declared files and files read in the entry, as ready handoffs do.

The logged scalar difficulty is the maximum central axis demand. Selection uses the axis bounds, not that summary. Decisions record `difficultySource` and `difficultyBounds`; records with neither declaration retain a missing-demand reason and bounds `[0, 1]`. Demand does not carry into another user entry or an unrelated phase.

This mapping is `feature-v11`. Its digest invalidates compiled domains from other mappings. The stored v1 preference scenarios, their feature vectors, and their cost and time anchors are unchanged; preference answers need no migration.

## Cost, speed, and cache

The cost feature uses an economic cost proxy, not the spend of the next invocation. The proxy is the prompt cost of the current request plus the benchmark output cost. The prompt cost uses registry input and eligible cache prices. When the registry lists pricing tiers, the tier with the highest threshold that the billed prompt tokens exceed prices the whole request, as Pi bills it. The benchmark output cost is the AA output tokens per Intelligence Index task at the exact served effort, multiplied by the registry output price. The router uses the token count as AA publishes it: no reference value, limit, or pool statistic scales it. The two terms have different horizons (one invocation and one benchmark task); the proxy accepts this. Another effort or another model never supplies the token count. When the output price is positive and the token count is missing, the output cost is zero or more: the cost has a minimum (the prompt cost) but no central value and no maximum. The cost feature is then 0 at the lower bound, the desirability of the prompt cost at the upper bound, and the midpoint of the two at the center. A zero output price makes the token count irrelevant. Cost desirability is logarithmic from $0.00001 to $10. A known zero price is free; an unknown price is not zero.

Prompt tokens are estimated from characters. Each provider bills its own tokens: a different tokenizer and request text that the provider adds. After each attempt with a complete usage report, the router records the billed prompt tokens (input, cache read, and cache write) divided by the estimate. Requests under 2,000 estimated tokens, requests with images, and ratios outside 0.5–4 are not recorded. The scale of a model is a moving average of these ratios (weight 0.3 for each new ratio). A model without a scale takes the mean scale of observed models with the same registry API. The prompt cost multiplies the prompt and its warm prefix by the scale. The context-window fit check uses the estimate without the scale. The scales persist in `prompt-token-scales.json` in the storage directory. Decision traces show `promptTokenScale` when it is not 1.

A recorded warm prefix gives cache credit only while it is younger than the candidate model's prompt cache lifetime. The lifetime comes from the model's `promptCache` entry in Pi's registry, for the retention tier of the request that wrote the prefix. The tier of a request is its `cacheRetention`, else `long` when `PI_CACHE_RETENTION=long`, else `short`. A model without a lifetime for the tier gets no credit, even when it has a cache-read price. Age is measured from the time the router observed the recorded request, before dispatch, not from the end of its stream. A request at retention `none` reads and writes no cache: it gets no credit and bills every prompt token at the input price. At `long`, a model that bills cache writes and declares a `long` lifetime bills the write at twice the input price, as Pi does for 1h writes. An effort that shares the model's cache uses the largest sibling prefix that is still inside the lifetime. Each prefix has a hit weight: 1 for this session, lower for another session. The weight is an authored value, not a measured hit rate. A weight of 0 means the prefix cannot hit. The central cost uses the largest prefix multiplied by its weight. The cost bounds are a possibility envelope, not a confidence interval. They use two outcomes: every prompt token misses, or the largest prefix that can hit does hit. The router does not add overlapping prefixes. When a cache read costs more than a miss, the hit outcome sets the upper bound. When a hit is possible and the registry gives no cache-read price, the central cost gives no cache credit, the minimum uses a free read, and the cost has no known maximum. The cost evidence then shows `cache-read-price:unknown`. Decision traces show the reason in the cost evidence as `cache-eligibility:<reason>`.

The time feature uses the benchmark-output time proxy: the AA output tokens per task divided by the measured output speed. This is not the wall time of an AA task and not the latency of the next invocation. Time desirability is logarithmic in seconds, with a shape of 60 seconds; a proxy of 3,600 seconds or more has desirability 0. When the served effort has no usable output speed, the time feature uses the minimum and maximum positive, finite speeds from active rows at other efforts of the same registry model. It keeps the served effort's token count. The slowest speed gives the lower desirability bound; the fastest gives the upper bound. The center is the midpoint of those bounds. The evidence code is `speed-other-effort`. This is an empirical estimate, not a guarantee that the missing speed lies within the observed range. One available speed gives a point estimate, not a measured observation. No speed evidence, or a missing token count, gives the interval [0, 1] with center 0.5. Task demand changes neither the cost nor the time transform. Cache estimates are not guaranteed cache hits. Preferences set the trade-off between these features and capability fit.

The offline target probe uses API catalog prices, including Anthropic prices for its bridge proxy. Production still uses the registered prices. There is no `apiCostModels` configuration.

## Thinking effort

Each measured effort is a separate candidate. The router selects the model and effort together.

An estimate can cover a supported lower effort. The router does not invent measurements above the highest measured effort.

The router never lowers its selected effort. It can increase effort to a supported level or to the incumbent's minimum thinking level.

An explicit user thinking choice follows the provider's supported levels. See [manual model control](commands.md#manual-model-control).

## Failure recovery

Delegation has no authentication or output deadline. It waits for completion, explicit failure, or caller cancellation.

Before output, an explicit provider failure can advance the fallback chain. The router can retry the same candidate for a retryable error.

After visible text, a tool call, or a thinking-buffer commit, replay is unsafe. A later failure returns to the consumer without another model replay.

Objective struggle is separate from provider failure. It includes repeated actions, repeated verifier failures, and stagnation detected by the router.

The serving model normally receives one recovery attempt before a later struggle triggers escalation.

Escalation selects a replacement candidate through the unified selector. The selector evaluates recovery features alongside capability, cost, and speed.

These mechanisms do not grade semantic answer quality. An incorrect answer without an observable failure can remain undetected.

See [Delegation](delegation.md) for retry counts, provider exclusions, attempt buffering, and manual/resume state.

## Implementation map

| Source | Responsibility |
|---|---|
| [Selector](../extensions/routing/optimization/select.ts) | One-pool minimax regret and its central fallback |
| [Task demand](../extensions/routing/features/task-demand.ts) | Task relevance, demand intervals, absolute targets, and required evidence |
| [Capability features](../extensions/routing/features/model.ts) | Benchmark normalization, shortfall scales, and capability fit |
| [Spend](../extensions/routing/features/spend.ts) and [cache](../extensions/routing/features/cache.ts) | Cache eligibility, economic cost proxy, and cost desirability |
| [Decision compiler](../extensions/routing/optimization/compile.ts) | Numerical validation and the numerical problem |
| [Difficulty](../extensions/routing/features/difficulty.ts) | Axis demands from accepted declarations |
| [Work phase](../extensions/routing/policy/work-phase.ts) | Entry state, task types, and handoff transitions |
| [Execution contract](../extensions/routing/policy/execution-contract.ts) | Plan validation, release, review, and strikes |
| [Provider](../extensions/serve/provider.ts) | Candidate preparation and stream orchestration |
| [Delegation](../extensions/serve/delegation.ts) | Attempts, retries, cancellation, and safe fallback |

[Architecture](overview.md#architecture) · [Scoring](scoring.md) · [Delegation](delegation.md)
