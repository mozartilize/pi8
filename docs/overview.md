# pi8 overview

pi8 selects models for main-session Pi turns. It uses benchmark measurements, registry metadata, and accepted task declarations.

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
| [Routing](routing.md) | Task types, capability targets, the comparison pool, effort, scoring, and recovery |
| [Architecture](#architecture) | System boundaries, data flow, session state, and implementation map |
| [Scoring](scoring.md) | Candidate expansion, quality references, price/speed scales, cache credit, and effort |
| [Delegation](delegation.md) | Attempts, retries, provider exclusions, output safety, and manual/resume state |
| [Work lifecycle](work-lifecycle.md) | Context collection, execution plans, review, completion, and reopen |
| [Benchmark data](benchmark-data.md) | Data sources, model matching, effort identity, and refresh behavior |
| [Observability](observability.md) | Logs, attempt timing, cost reports, and privacy limits |
| [Glossary](glossary.md) | Project terms and their meanings |

## Scope and limitations

Automatic selection uses one comparison pool with minimax regret optimization. It has no capability tiers and no capability bands.

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

Tool gates control the workflow. They do not isolate files, shell commands, or credentials.

### Implementation map

| Source | Responsibility |
|---|---|
| [Entry point](../index.ts) | Register the extension and connect Pi hooks |
| [Provider](../extensions/serve/provider.ts) | Registry access, task resolution, and turn orchestration |
| [Unified decision](../extensions/serve/unified-decision.ts) | Candidate feature assembly and decision resolution |
| [Candidate builder](../extensions/routing/score/scorer.ts) | Candidate identity, capability reads, thinking levels, and context fit |
| [Features](../extensions/routing/features/candidate.ts) | Task demand, capability fit, economic spend, latency, and recovery |
| [Optimization](../extensions/routing/optimization/select.ts) | Decision problem compilation, weight domain, and minimax regret selection |
| [Delegation](../extensions/serve/delegation.ts) | Authentication, retries, provider failures, cancellation, and timing |
| [Work phase](../extensions/routing/policy/work-phase.ts) | Entry state, task types, and handoff transitions |
| [Execution difficulty](../extensions/routing/features/difficulty.ts) | Rubric axis demand and file measurements |
| [Execution contract](../extensions/routing/policy/execution-contract.ts) | Plan validation, release, review, and strikes |
| [Contract tool](../extensions/serve/execution-contract-tool.ts) | Plan acceptance, target observation, and tool tracking |
| [Benchmark store](../extensions/bench/store.ts) | Normalized rows, aliases, backups, and matching |

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

Custom integration messages, shell execution results, system messages, and Pi summaries do not start another routing entry. They remain in model context. The router matches converted user-role messages to Pi's active session projection by timestamp and content, so context edits retain their source. These events do not end an accepted handoff or remove its rubric.

Content comparison ignores object property order but preserves block order and image data. When a user message and a custom event have identical timestamps and content, the router matches each occurrence once in projection order. If context has fewer or more identical occurrences, their origin is ambiguous. The router treats them as possible user requests rather than discard a real request.

`[pi8-settle]` reminders and configured `syntheticPrefixes` also do not start another entry. Prefixes cover integrations whose source is not available in the projection. Unmarked user-role messages without source evidence remain user requests.

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
timeout 60 npx vitest run
```

[Project overview](../README.md)
