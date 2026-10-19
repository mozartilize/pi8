# Scoring and features

[Overview](overview.md) · [Routing](routing.md) · [Architecture](overview.md#architecture)

The candidate builder and feature engine prepare actions for unified minimax regret selection. Candidates expand by provider, model, and supported effort, evaluate ten bounded desirability features, and rank across the permitted pool.

## Candidate expansion

Candidates use `provider/id[:effort]` identities. Each supported, measured effort produces a separate candidate with its own measurements.

Delegation calls `modelRegistry.streamSimple`. Providers that reject bare delegated calls are not automatic candidates.

An unmeasured supported effort can receive an estimate from a higher measured effort.

`off` requires a provider mode that disables thinking:

- A non-reasoning model has only this mode.
- A reasoning model needs a supported `off` mapping and a provider that can disable thinking.
- `claude-bridge` cannot disable thinking. Without an effort, Claude Code uses its default effort.

The router never estimates `minimal`. Several providers map it to `low`, so an invented measurement would not identify a separate mode.

A measured `minimal` row remains available when supported.

If the model supports none of its measured efforts, it receives one candidate without an effort label.

Context fit checks `contextWindow >= promptTokens × 1.2`. An unknown window does not cause rejection.

## Downward effort estimates

An estimate starts at the nearest measured effort above the requested level. It subtracts one conservative quality adjustment per level.

The adjustment is the 90th percentile of observed adjacent-level decreases on each quality axis.

The router calculates these adjustments when candidate construction follows a store change. An axis with insufficient observations remains unestimated.

The router does not estimate above the highest measured effort.

Estimated rows retain registry price and context metadata. They do not inherit task cost, speed, or latency measurements from another effort.

Exact knowledge and research measurements never transfer across efforts. An unlabelled row does not supply them to a named effort.

## The ten desirability features

Every action evaluates ten features in `[0, 1]`, where larger values indicate higher desirability (`feature-v11`):

| Feature | Input | Meaning |
|---|---|---|
| `reasoningFit` | Task reasoning demand + Intelligence | Fit against the phase's reasoning target |
| `agenticFit` | Task agentic demand + Terminal-Bench 4.0 | Fit against the phase's agentic coding target |
| `researchFit` | Task research demand + Briefcase/Omniscience | Fit against the phase's research target |
| `inputFit` | Context size + image inputs + LCR/MMMU-Pro | Fit for long context (>= 64k tokens) and vision reasoning |
| `costDesirability` | Prompt cost + benchmark output cost | Logarithmic economic cost desirability ($0.00001 to $10) |
| `timeDesirability` | AA output tokens / output speed | Logarithmic benchmark time desirability (60s shape, 3600s saturation) |
| `continuity` | Incumbent match | Affinity for the currently serving model |
| `frictionAvoidance` | Trajectory friction on model/effort | Penalty for observed stagnation or struggle |
| `effortRecoveryFit` | Failed candidate rework | Preference for higher effort on the same model after rework |
| `modelSwitchRecoveryFit` | Failed candidate rework | Preference for switching models after rework |

Each feature supplies an interval `[lower, upper]` and a central value. Exact measurements collapse the interval to a single point. Missing evidence widens the interval, representing uncertainty in minimax regret.

## Capability fit and targets

Normalized benchmark quality scales use absolute reference strengths:

| Axis | Reference strength | Metric |
|---|---:|---|
| Intelligence | 57.6 | Artificial Analysis Intelligence Index |
| Coding | 78.3 | Artificial Analysis Coding Index |
| Agentic coding | 63.6 | Terminal-Bench 4.0 pass rate |
| Agentic Index | 57.9 | Artificial Analysis Agentic Index |
| Research | 0.61 | Briefcase rubric pass rate |
| Long context | 1.0 | LCR correctness |
| Vision reasoning | 1.0 | MMMU-Pro correctness |

Capability targets interpolate linearly between easy and hard endpoints based on axis demand:
- Reasoning target: 0.20 to 0.55 (shortfall scale 0.15)
- Agentic target: 0.01 to 0.60 (shortfall scale 0.20)
- Research target: 0.25 to 0.65 (shortfall scale 0.20)

Fit formula: `clamp(1 − max(0, target − quality) / shortfallScale, 0, 1)`.

Surplus capability earns no extra fit. Phase relevance scales the fit.

## Economic cost proxy

The cost feature uses an economic cost proxy:

```text
proxy = prompt cost + benchmark output cost
```

1. **Prompt cost:** Billed prompt tokens multiplied by registry rates, scaled by `promptTokenScale`.
2. **Benchmark output cost:** Artificial Analysis output tokens per task at the exact served effort, multiplied by registry output price.

Prompt tokens are estimated from characters. The router records the ratio of billed prompt tokens to estimated tokens after each complete attempt. `promptTokenScale` is an exponential moving average of these ratios, persisted in `prompt-token-scales.json`.

When the output token count is missing and output price is positive, the cost feature lower bound is 0, the upper bound is the desirability of prompt cost alone, and the center is their midpoint.

Cost desirability is logarithmic:

```text
costDesirability = clamp(1 − log10(max(cost, 0.00001) / 0.00001) / log10(10 / 0.00001), 0, 1)
```

## Latency and time desirability

The time feature divides the Artificial Analysis output tokens per task by measured output tokens per second.

When the served effort has no measured output speed, the router estimates speed from the minimum and maximum speeds of active rows at other efforts of the same registry model (`speed-other-effort`).

Without speed evidence or token counts, time desirability defaults to `[0, 1]` with center 0.5.

Time desirability is logarithmic in seconds:

```text
timeDesirability = clamp(1 − log10(max(seconds, 0.1) / 0.1) / log10(3600 / 0.1), 0, 1)
```

## Cache credit

A recorded warm prefix gives cache credit only while younger than the model's `promptCache` lifetime for the request's retention tier (`short` or `long`).

A model without a declared lifetime gets no cache credit, even with a published cache-read price.

Cost bounds evaluate two outcomes:
- Miss outcome: all prompt tokens miss cache.
- Hit outcome: the largest qualifying prefix hits cache.

When a cache read costs more than a miss, the hit outcome sets the upper cost bound. When a hit is possible but the registry omits a cache-read price, the cost has no known maximum (`cache-read-price:unknown`).

## Protocol preference

Protocol preference tracks independent reminder and ignore rates for tool-use compliance.

Counts decay with a 30-day half-life. Reminder-rate preference requires 30 effective entries. Ignore-rate preference requires 10 completed reminder episodes.

Each rate uses a Wilson lower bound. Configured weights determine the penalty, capped by `switchMargin`.

Unset `reputationWeights` leaves compliance collection active without applying penalties.

## Served thinking effort

The router selects model and effort together.

`levelFrom` raises the selected effort to the nearest supported level. It never lowers the selected effort.

The incumbent's minimum thinking level comes from the effort actually served, even if no benchmark row measures it.

An unlabelled candidate uses Pi's session thinking level. Without a sent level, the provider disables thinking or uses its default.

An explicit user choice uses Pi's nearest-supported resolution.

## Incumbent minimums

Ordinary tool-loop invocations retain both incumbent capability and thinking minimums.

The router clears these minimums at these boundaries:
- A released execution plan.
- Another accepted handoff, until a model serves the new phase.
- An applied trajectory handoff.
- The start of a `new`, `resume`, `switch`, or `reopen` entry.

A retained plan keeps both minimums. A fallback candidate can serve without satisfying the declared boundary.

[Candidate builder source](../extensions/routing/score/scorer.ts) · [Features source](../extensions/routing/features/candidate.ts)
