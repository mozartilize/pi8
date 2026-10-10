# pi8 overview

pi8 selects models for Pi turns and subagent roles. It uses benchmark measurements, registry metadata, and accepted task declarations.

The router runs inside Pi. It does not start a gateway or make separate model calls to classify requests.

Every model call serves the user's request.

## Start here

1. Read [Getting started](getting-started.md).
2. Select your providers in [Configuration](configuration.md).
3. Use the [Command reference](commands.md) to inspect decisions.

## Guides and references

| Document or section | What you can learn |
|---|---|
| [Getting started](getting-started.md) | Requirements, installation, first sync, and first routed turn |
| [Configuration](configuration.md) | Options, defaults, model patterns, and environment variables |
| [Command reference](commands.md) | Commands, arguments, persistence, and examples |
| [Routing](routing.md) | Task types, capability tiers, effort, scoring, and recovery |
| [Architecture](#architecture) | System boundaries, data flow, session state, and implementation map |
| [Scoring](scoring.md) | Candidate expansion, quality references, price/speed scales, cache credit, and effort |
| [Delegation](delegation.md) | Attempts, retries, provider exclusions, output safety, and manual/resume state |
| [Work lifecycle](work-lifecycle.md) | Context collection, execution plans, review, completion, and reopen |
| [Subagents](subagents.md) | Role selection, explicit models, workflow limits, and provider exclusions |
| [Benchmark data](benchmark-data.md) | Data sources, model matching, effort identity, and refresh behavior |
| [Observability](observability.md) | Logs, attempt timing, cost reports, and privacy limits |
| [Glossary](glossary.md) | Project terms and their meanings |

## Scope and limitations

The default policy is `legacy`. The `cheapest-sufficient` policy is an evaluation comparator, not an activated production policy.

Benchmarks inform selection. They do not prove that a model can complete a particular task.

A provider can wait indefinitely. Delegation has no authentication or output deadline. The caller can cancel the request.

## Architecture

pi8 registers the synthetic `router/auto` provider inside Pi. It resolves a request, selects a model and effort, and delegates its stream.

### System boundaries

| Component | Responsibility |
|---|---|
| Pi | Model registry, authentication access, session transcript, tools, and supported thinking levels |
| pi8 | Task state, benchmark matching, candidate selection, delegation, and work tracking |
| Artificial Analysis | Published benchmark measurements |
| Model provider | Authentication result, model availability, generated output, and usage |
| pi-subagents | Child execution and workflow controls |

Tool gates control the workflow. They do not isolate files, shell commands, or credentials.

### Implementation map

| Source | Responsibility |
|---|---|
| [Entry point](../index.ts) | Register the extension and connect Pi hooks |
| [Provider](../extensions/serve/provider.ts) | Registry access, task resolution, scoring, delegation, and subagent authentication probe |
| [Scorer](../extensions/routing/score/scorer.ts) | Pure candidate scoring, capability tiers, and effort resolution |
| [Delegation](../extensions/serve/delegation.ts) | Authentication, retries, provider failures, cancellation, and timing |
| [Work phase](../extensions/routing/policy/work-phase.ts) | Entry state, final-step requirements, and handoff minimums |
| [Execution difficulty](../extensions/routing/policy/execution-difficulty.ts) | Rubric and source-measurement requirements |
| [Execution contract](../extensions/routing/policy/execution-contract.ts) | Plan release, execution, review, and strikes |
| [Contract tool](../extensions/serve/execution-contract-tool.ts) | Plan acceptance and tool-event tracking |
| [Benchmark adapters](../extensions/adapters/artificial-analysis.ts) | Join API and public-page measurements |
| [Subagent injection](../extensions/agents/subagents.ts) | Select and inject role models without a separate credential probe |

The provider owns the three-second credential probe for subagent selection. Hook wiring runs that probe before role assignment.

### Session state

Routing state uses instantiable domain containers:

| Container | State |
|---|---|
| `RouterSession` | Session generation, last decision, last served model, candidate cache, and domain containers |
| `BlacklistState` | Runtime model/provider exclusions and normalized session patterns |
| `IntentState` | Cached entry intent and work-phase state across tool continuations |
| `RuntimeBindings` | Pi context, model registry, and provider-registration signature |

`session_start` clears session routing state. Runtime bindings survive that reset and clear only on extension shutdown or reload.

Asynchronous results check the active session generation before writing state. A result from a replaced generation cannot update the current session.

The router caches the resolved intent by user entry. Tool-loop continuations reuse it.

`[pi8-settle]` reminders and configured `syntheticPrefixes` do not start another entry.

### State boundaries

Work-item status, task type, and execution-contract status are separate states.

A completed item can retain its serving model. Reopening changes the item status and permits a new routing decision.

An active execution contract belongs to its entry. Executor strikes belong to the work item and can survive later entries.

Requests sent under a concrete model do not continue the active item automatically. A later routed request collects context and selects work again.

A model switch without a request preserves the active item, but it ends the incumbent association.

See [Work lifecycle](work-lifecycle.md#session-and-branch-transitions) for transcript records and branch handling.

### Failure boundaries

New hooks, commands, and the provider boundary must catch internal errors. An internal bookkeeping failure must not block the user's turn.

Missing required benchmark data produces a setup error before delegation. Manual pins and concrete-model requests do not use that readiness check.

Provider fallback is separate from objective trajectory escalation. Neither mechanism grades the meaning of an answer.

See [Delegation](delegation.md) for attempt buffering and replay constraints.

## Implementation checks

Detailed formulas and state transitions appear in the [Scoring](scoring.md), [Delegation](delegation.md), and [Work lifecycle](work-lifecycle.md) references.

To check implementation changes, run:

```sh
npm run tsc
timeout 120 npx vitest run
timeout 120 npm run test:candidate-policy
```

[Project overview](../README.md)
