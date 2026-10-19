# Pi context preparation

## Scope and executable evidence

These mechanism probes use the installed Pi 1.3.0 SDK, agent loop, extension
runner, model runtime and session manager. Fake providers produce local streams.
They make no HTTP requests and use no paid models. They do not load the production
routing extension or prove that its adapters satisfy the migration conditions.

```bash
timeout 120 npx vitest run extensions/serve/pi-context-preparation.probe.test.ts \
  --test-timeout 10000
```

The probe uses model A with a 1,000,000-token context window and model B with a
272,000-token context window. Normal compaction settings reserve 16,384 tokens
and keep 20,000 recent tokens. Long history is finalized before each request.
The tests observe both the extension context and the provider-visible messages.

## Verified mechanisms

| Mechanism | Result |
|---|---|
| Physical 1M wrapper delegates to B | Pi prepares for the wrapper, not B. A 400k-token request reaches B without compaction. |
| Native virtual model selects B | A fitting 200k-token history is served directly. A 400k-token history is compacted before the context hook. |
| Switch directly to physical B | The summary request uses B and exceeds B's context window. Fake acceptance does not prove capacity. |
| Virtual direct route selects A for summaries | Summary requests use A and fit its context window in this probe. Compaction and usage are recorded in the session. |
| Context handler throws after failed compaction | Pi reports the extension error and continues. The exception does not prevent oversized dispatch. |
| Context handler calls `ctx.abort()` | No target provider call occurs after failed or disabled compaction. An irreducible oversized current prompt is also blocked. |
| Context handler runs after a tool result | The next request is checked again. A 300k-token tool result that cannot be removed from the current turn is blocked. |
| Selection revision changes during summary | The final context handler can abort before target dispatch. The persisted compaction remains usable by a subsequent fresh run. |
| Native summary is cancelled | No target request occurs and no compaction entry is persisted. |
| Native session is reopened from its file | The compaction entry and its usage survive. The resumed request fits B without another compaction. |
| Physical provider performs answerless A-to-B fallback | The failed attempt can be buffered, but Pi does not run preparation or the context hook again for B. B receives the original oversized prompt. |
| `ctx.compact()` before agent start | The callback can complete before the run starts. The context hook sees rebuilt history and can check it before dispatch. |
| `ctx.compact()` inside the context hook | Manual compaction aborts the entire run. Its completion follows the consumer terminal message. A later run can use the compacted history. |
| Physical B has a 100k-token reserve override | Native virtual preparation does not apply that target override in this probe. A 200k-token history is not compacted, although B's resolved threshold requires it. The final guard blocks dispatch. |

The provider-visible prompt includes additional system context. The hook's
message estimate is not the complete provider request. The tests use large
separations from the boundary; they do not prove exact token accounting for
system prompts, tools, images or provider-specific serialization.

## Candidate solutions

### Native virtual routing with a final context guard

This is a supported candidate for initial requests and ordinary continuations:

1. Resolve the serving action through native virtual routing.
2. Use a feasible direct route for summarization.
3. Let Pi prepare the history for the selected context window.
4. Check fit, selection revision, actor authorization and cancellation in the
   context hook. Call `ctx.abort()` when a check fails.

The guard must use a conservative complete-request estimate, not only the
messages estimate used to distinguish mechanisms in these probes. It must
account for other handlers that can modify context after it runs.

This candidate does not satisfy the full operational fallback contract.
`ctx.abort()` ends the run; it does not discard one attempt and continue to
another action within the same buffered stream. Native preparation also needs
correct physical-target compaction settings. Native virtual-model state alone
is not a router assignment, a dispatch receipt or a settlement receipt.

### Manual preparation before agent start

An extension can await the `ctx.compact()` callbacks before the agent starts.
This prepares finalized history without a private-session patch. A final guard
can still block an oversized current prompt.

Manual compaction uses the active session model and its settings. It has no
public target-model argument. The incoming prompt is not a finalized history
entry at this boundary. This mechanism cannot prepare a fallback that is chosen
inside an active provider stream.

#### Preparation fallback from one selection

`routing/policy/assignment-transaction.ts::routeAssignment()` uses the chosen
action first, then the remaining ranking. It does not run another selection
for a fallback target. Cancellation stops the chain. A profile, work or
authorization change requires the bounded fresh selection before another
target can be prepared.

A failed or throwing preparation excludes every target with the same input
budget at the same context revision. Effort variants of one model have one
budget, so they cannot repeat a summary request for the same context. A
throwing preparation counts as a compaction attempt, because the host can
have started a summary request before the exception.

Each summary request is a paid model call. One invocation permits at most
`MAX_COMPACTION_ATTEMPTS` (2): one for the chosen target and one for a
fallback. After that limit, the host receives `allowCompaction: false` and
can prepare only targets that already fit. The limit also guarantees that the
chain ends.

Each target is prepared against the current context. A persisted compaction is
not undone when its prompt still exceeds the target's budget. The next target
uses that context. A compaction that changes the context checks the ranking
again from the top, so a preferred target that fits is served. Only a
ready target gets a reservation. Planning and failed preparation consume no
recovery claim.

The outcome names the prepared action in `target`. `decision.chosen` names
the selection, which can differ. The outcome also carries counts of
preparation attempts, failures, host exceptions and compaction attempts. It
carries no target names or messages.

The SDK prototype invokes this transaction in `before_agent_start`, with a
fixed B-to-C ranking and a stable signal. It uses Pi's public `ctx.compact()`
callbacks and estimates the rebuilt session context, incoming text and system
prompt before returning ready. A final context guard checks the actual run.

| Initial prompt | B preparation | C context window | Result |
|---|---|---|---|
| About 400k | Compaction succeeds | 512k | B serves. C is not prepared. |
| About 400k | Compaction fails | 512k | C serves without another compaction, although C is smaller than A's 1M window. |
| About 400k | Compaction fails | 200k | C preparation performs a second summary. Successful compaction makes the prompt fit C, then C serves. |

Each prototype case uses one selection, fitting A summary requests and one
consumer terminal message. A failed summary produces no consumer terminal
message.

### Router window advertised for the target

Production re-registers `router/auto` with the window of the model that served
last (`serve/provider.ts::registerAutoRouterProvider`). The probe registers a
physical router model through `pi.registerProvider` and, in
`before_agent_start`, re-registers it with the selected target's window. Pi
refreshes the session model after a registration.

| Advertised window | 200k history and a 100k tool result, target B 272k |
|---|---|
| B's window | Pi compacts between the tool result and the next request, without ending the run. Both requests go to B and fit. The consumer receives `toolUse`, then `stop`. |
| B's window, summary fails | No compaction is persisted. The final guard blocks the oversized request and the run ends. |
| Fixed 1M | Pi does not compact. Only the final guard prevents oversized dispatch. |

Pi resolves compaction settings for the advertised router model, not for the
physical target. Target-specific reserve and keep overrides do not apply.

## Settled integration policy

The installed public API covers each preparation point that does not need
compaction inside an active provider call:

1. **Before the run:** select, then prepare through `routeAssignment()` in
   `before_agent_start`. Advertise the reserved target's window on
   `router/auto`.
2. **Between requests in a run:** Pi compacts against the advertised window.
   The provider re-selects for each request.
3. **Before each dispatch:** the `context` hook checks fit, selection revision,
   authorization and cancellation, and calls `ctx.abort()` when a check fails.
   A thrown exception does not prevent dispatch.
4. **Inside an active provider call:** operational fallback and pre-output
   recovery use only targets whose input budget holds the prompt that Pi
   already prepared. A target that needs compaction is not attempted in that
   call. The next run prepares for it. This restriction applies only to the
   fallback chain of one call; ordinary routing keeps smaller-window targets.

Under this policy, no new Pi API is necessary. `ctx.compact()` inside a run
aborts the whole run, so the router does not use it there. The router does not
make its own summary requests.

The guard must use a conservative complete-request estimate, including system
prompt and tool schemas. These probes do not prove exact token accounting for
tools, images or provider-specific serialization. They also do not prove
cancellation during pre-run manual compaction or the billing of every failed
summary request. No production path uses this policy yet.

### Abort, compact and start another run

The probe demonstrates that a later run can serve after manual compaction.
This is not transparent operational fallback: the abandoned run has already
produced a terminal message. Awaiting manual compaction inside a context handler
would also wait for the run that is waiting for that handler. Do not use this
pattern as an attempt-local preparation operation.

## Verification

- `npm run tsc`: passed, including eval compilation.
- `timeout 900 npx vitest run`: 112 files passed and 2 skipped. 1935 tests
  passed and 3 skipped.
- Targeted runs pass: 17 preparation-fallback contracts, 20 assignment
  contracts and 22 Pi SDK mechanism probes.
- Each of these mutations makes at least one preparation-fallback test fail:
  failures keyed by target instead of budget, no compaction attempt limit, and
  no ranking check after a new context. Without the limit, the transaction
  does not end.
