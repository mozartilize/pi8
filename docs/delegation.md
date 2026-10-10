# Delegation

[Overview](overview.md) · [Routing](routing.md) · [Observability](observability.md)

Delegation walks the ranked fallback chain. Each entry identifies a provider, model, and effort.

The first attempt with meaningful output serves the request.

## Availability and waiting

Registry authentication filtering works at provider level, not model level. The per-attempt credential check determines whether the selected model can run.

An authenticated provider can still reject a model or wait indefinitely.

Delegation sets no authentication or output deadline. It waits for completion, explicit failure, or caller cancellation.

Silence alone does not advance the fallback chain.

## Before output

| Condition | Handling |
|---|---|
| Model absent from the registry | Exclude the model and try the next candidate |
| Missing credentials or authentication error | Exclude the failed candidate and add a provider strike |
| Pending authentication or silent stream | Continue waiting unless the caller cancels |
| Provider error | Retry the candidate when eligible, then try the next candidate |
| Clean completion without text, thinking, or tool output | Try the next candidate |
| Empty completion while answering a tool result | Ask the same candidate once to continue, then try the next candidate |
| Reasoning-only output limit, without text or a tool call | Try the next candidate while replay remains safe |
| Caller cancellation | End the turn without a blacklist change |

Retryable provider errors allow up to two transient retries or one generic retry on the same candidate.

The router buffers an answerless attempt's events. It discards those events before fallback, including terminal events.

Pi treats its first terminal `done` event as the end of the turn. Releasing an answerless attempt would prevent another candidate from answering.

Lifecycle-only events do not count as meaningful output.

## Tool-result continuation

Some providers run their own agent loop. They can decline a tool result for a call made by another model.

After an empty completion on a tool result, the router appends a user turn to the delegated request:

```text
Continue the task from the tool results above.
```

The same candidate receives one continuation attempt with the whole history. The appended turn does not enter Pi's transcript.

A decline does not blacklist the model or add a provider strike.

## Provider exclusions

Three provider-health strikes exclude the provider's remaining models from the current fallback loop.

Credential, authentication, transport, and provider errors can add strikes.

Missing-registry errors and model-specific output-limit exhaustion do not exclude sibling models through provider strikes.

A shared usage-limit error excludes the entire provider for the session immediately.

This includes quota, billing, subscription, `GoUsageLimitError`, and rate-limit failures recognized by the usage-limit classifier.

A model-specific output limit does not create that session exclusion.

After restoring provider access, use:

```text
/router-blacklist remove <provider>/*
```

## Released output

Replay stops after:

- Visible text.
- A tool call.
- A thinking-buffer commit.

A later error returns to the consumer. The router does not repeat the attempt on another model.

This constraint prevents duplicate text and duplicate side effects.

See [Attempt timing](observability.md#attempt-timing) for milestones and output-state flags.

## Objective trajectory escalation

Trajectory escalation is separate from provider-error fallback.

Repeated actions, repeated observations, persistent verifier failures, and stagnation can establish objective struggle.

The serving model normally gets one recovery attempt. Evidence starts again, and the next request asks it to inspect errors before another edit.

A later struggle of the same model schedules a same-task-type selection for the next provider invocation.

Under `legacy`, the target is the cheapest strictly stronger candidate in the next capability band. Higher bands follow in the fallback chain.

A pre-output struggle can escalate immediately while replay remains safe.

A failure signature warns after two corrective attempts and becomes severe after three. One failed correction is part of an ordinary verification loop.

Models do not declare their own escalation. A closed execution plan permits transfer, while the router selects its executor.

The evaluation comparator uses the complete proven-stronger set rather than named bands. See [Scoring](scoring.md#evaluation-comparator).

## Manual-pin state

A manual pin retains `router/auto` as Pi's active model. It changes only session state.

A pinned turn:

- Restricts scoring to the pinned model.
- Records cause `manual-override`.
- Keeps only the selected effort variant in its fallback chain.

Same-model retries remain available. Failure never substitutes a different model.

The picker follows Pi's authenticated model list and session scope. It excludes the synthetic `router/*` provider.

It does not apply automatic allowlists, blacklists, usage-limit exclusions, or runtime model failures.

A pin outside the automatic candidate pool expands from the registry on demand. A repeat failure returns the provider error.

Session reset clears the pin. The command writes neither Pi settings nor pi8 configuration.

## Thinking-level changes

A session thinking-level change that the router did not write pins the last served model at the new supported level.

An existing pin changes to that level. Before any model serves, the change is only a one-turn effort override.

Pi's thinking-selection event has no reliable source identity. It also fires for router updates and model switches.

The router therefore checks the next main-loop request against `syncedThinkingLevel`, captured after its last synchronization.

`isAgentLoopRequest` requires both the active run's abort-signal identity and agreement with Pi's session thinking level.

A background caller can supply its own signal or level. That request receives its requested effort without pin detection or session thinking-state writes.

Switching to `router/auto` clears the synchronization baseline.

## Resume state

The first pin saves the current automatic decision in `resumeSnapshot`.

`/router-manual resume` removes the pin and discards pin-owned pending trajectory escalation.

The next routed turn serves the saved decision directly with cause `resume`. It does not classify or score the request again.

The router filters the saved chain against currently routable candidates. If none remain, ordinary selection resumes.

`resumeIntentKey` limits the saved decision to one user entry. Tool-loop continuations reuse it. The next entry recomputes routing.

Without a pin or scheduled snapshot, `resume` makes no change.

## Semi-automatic state

With `semi: true`, an interactive model change asks for confirmation before delegation.

Accepting uses the new model. Declining retains the incumbent for that entry with cause `semi-hold`.

Tool-loop continuations reuse the hold. Selecting a specific model creates a manual pin.

Fallback after a failed attempt asks again. Dismissal or cancellation ends the turn rather than selecting another model.

Non-interactive sessions omit this gate. The command saves `semi` in configuration.

[Delegation source](../extensions/serve/delegation.ts) · [Thinking-state integration](../extensions/serve/provider.ts)
