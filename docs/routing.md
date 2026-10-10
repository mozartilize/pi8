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
       Apply capability tiers
                 |
       Rank candidates within each tier
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

## Capability tiers

The router assigns each candidate to one of three tiers:

| Tier | Condition |
|---|---|
| 0 | The candidate meets every required minimum. |
| 1 | A required measurement is missing, with no measured failure. |
| 2 | A measured value is below a required minimum. |

Tier 0 precedes tier 1. Tier 1 precedes tier 2. Every tier remains in the fallback chain.

Missing information does not count as low difficulty or weak quality. A measured failure still counts when another measurement is missing.

Price, speed, cache credit, and protocol preference cannot compensate for a missed minimum across tiers.

## Default capability minimums

The production policy is `legacy`:

| Task type | Required measurements |
|---|---|
| `lightweight` | None |
| `gather` | Intelligence ≥ 20 |
| `plan`, `review` | Intelligence ≥ 30, Omniscience ≥ 0, Briefcase rubric ≥ 0.35 |
| `implement` | Agentic coding ≥ 34 |

Agentic coding is the Terminal-Bench 4.0 pass rate, expressed as a percentage.

An explicit implementation requirement below 0.45 uses the AA Agentic Index. Its minimum is `requirement × 57.9`.

Requirements of 0.45 or more use agentic coding. The default implementation request also uses agentic coding.

Long requests need additional measurements. At 64,000 estimated tokens or more, LCR must be at least 0.30.

Image requests need registry image support and MMMU-Pro of at least 0.30.

These values use the calibrated benchmark scales. They do not depend on which models your allowlist contains.

## Difficulty declarations

A plan or review declaration uses the reasoning rubric. An implementation declaration uses the execution rubric.

The router combines rubric levels and source measurements into a requirement. It does not accept a model's cost estimate as a capability judgment.

Without a scored criterion, task defaults apply. Missing criteria inherit the highest supplied level in a partly scored rubric.

For bounded implementation, `openDecisions` of at most 3 limits the rubric contribution to 0.65.

The declared final step can still raise the handoff minimum. In legacy, a `moderate` final step can retain the strong-band minimum of 0.70.

This handoff ceiling does not cap `commit_execution` requirements. Execution plans use their own retention rules.

See [Work lifecycle](work-lifecycle.md#requirement-formulas) for the formulas and plan-release thresholds.

## Cost, speed, and cache

The router uses one cost scale for each selection. It prefers task cost when benchmark coverage is sufficient.

Otherwise, it uses blended registry token prices. It does not mix task cost and token prices within one selection.

Speed similarly uses task time or output tokens per second. Missing values receive no credit on the selected scale.

Recent candidates can receive bounded prompt-cache credit from their published cache rates. A cache estimate is not a guaranteed cache hit.

Protocol penalties require sufficient history and configured weights. Neither preference can change capability tiers.

See [Scoring](scoring.md) for candidate expansion, scale coverage, reference strengths, cache estimates, and effort resolution.

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

Legacy escalation selects the cheapest strictly stronger candidate in the next capability band. Higher bands remain in the fallback chain.

The evaluation comparator considers the complete proven-stronger set before cost preference. It does not use named capability bands for this selection.

These mechanisms do not grade semantic answer quality. An incorrect answer without an observable failure can remain undetected.

See [Delegation](delegation.md) for retry counts, provider exclusions, attempt buffering, and manual/resume state.

## Evaluation comparator

`PI8_POLICY_VERSION=cheapest-sufficient` selects the evaluation comparator. Production remains `legacy`.

The comparator uses Intelligence for every implementation requirement. The default minimum is `0.65 × 57.6`, or approximately 37.4.

Explicit implementation requirements use `requirement × 57.6`. Other task minimums and input-shape minimums remain unchanged.

This mapping is an experimental parameter. A passing test suite does not prove task sufficiency.

Paid evaluations and production activation require separate approval.

## Implementation map

| Source | Responsibility |
|---|---|
| [Scorer](../extensions/routing/score/scorer.ts) | Capability checks, preference, and effort resolution |
| [Work phase](../extensions/routing/policy/work-phase.ts) | Final-step requirements and handoff minimums |
| [Execution contract](../extensions/routing/policy/execution-contract.ts) | Plan state and retention decisions |
| [Provider](../extensions/serve/provider.ts) | Candidate preparation and stream orchestration |
| [Delegation](../extensions/serve/delegation.ts) | Attempts, retries, cancellation, and safe fallback |

[Architecture](overview.md#architecture) · [Scoring](scoring.md) · [Delegation](delegation.md)
