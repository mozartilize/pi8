# Unified routing readiness

## Current implementation

The unified selector is not connected to production routing. Provider routing,
delegation and subagent selection still use the existing selection paths.
Selector tests do not establish runtime migration safety.

The following modules have executable offline tests:

- Effective-action enumeration and per-axis benchmark provenance.
- Candidate features, cache accounting and AA output-equivalent demand scaling.
- Preference validation, scenarios, domain identity and exact regret selection.
- Transactional assignment, preparation fallback through the retained ranking,
  recovery consumption and single-use dispatch.
- Explicit actor authorization and on-demand pre-output intervention.

Two policy decisions are settled:

1. An explicitly authorized actor settles a boundary only after actual serve.
   Fallback membership and higher effort grant no authorization.
2. Pre-output intervention awaits the shared selector on demand. The final
   output check, abort and reservation form one atomic operation.

These modules currently have controlled-port tests, not complete Pi integration
coverage. `/router-preferences` and its optional setup notice are not implemented.
Preference storage and notice-state helpers exist.

## Conditions before runtime migration

| Condition | Current evidence | Required evidence |
|---|---|---|
| Controlled prepared dispatch | The integration policy is settled and uses only the installed public API. Maintained Pi 1.1.0 SDK probes cover each point: pre-run preparation fallback with a compaction attempt limit, in-run compaction against an advertised target window, and `ctx.abort()` in the context hook. Throwing from that hook does not prevent dispatch. | Implement the policy in the production adapter, with a complete-request estimate. Restrict operational fallback and recovery inside one provider call to targets that hold the prepared prompt. Resolve physical-target compaction overrides. |
| Feasible summary route | Native virtual routing can use a fitting larger model for summaries. Direct switching to a smaller model can send an oversized summary request to that model. | Validate the actual summary action's capacity and accounting. Failed, disabled or cancelled compaction must send no oversized request to the selected target. |
| Production selection budget | Approved: 500 ms in total with no pair cap (`PRODUCTION_SOLVER_BUDGET`). The allowlisted pool solved exactly in every recorded 500 ms sample. | Validate cold starts and representative profiles in the production adapter. |
| Preference command | Schema, persisted profile snapshots and domain compilation exist. | Implement the five-question command, truthful applied/softened/nonbinding status and nonblocking one-time interactive notice. Make no provider calls. |
| Pi host mechanism tests | Maintained SDK tests cover pre-run preparation fallback, context preparation, final abort guards, after-tool checks, manual compaction ordering, cancellation and file-backed resume. Controlled-port tests also exist. | Add production adapter coverage for asynchronous hook selection, preserved child arguments and each operational fallback. |

See [Pi context preparation](pi-context-preparation.md) for the settled
integration policy and its evidence. The executable probes are in
`extensions/serve/pi-context-preparation.probe.test.ts`.

Do not delete smaller-window actions to bypass the host preparation condition.
Do not compact while an abandoned attempt can still commit output. Do not
substitute native retry for buffered fallback. Returned virtual-model state
is not an actual-serve receipt.

Inside an active provider call, operational fallback and recovery use only
targets whose input budget holds the prompt that Pi already prepared. This
restriction applies to the fallback chain of one call. Ordinary routing keeps
smaller-window targets, and the next run prepares for them. A private-session
patch is not an accepted integration.

Full prepared-dispatch, settlement, recovery, child-argument and resume tests
are runtime migration exit conditions. They are not all prerequisites for the
first production adapter edit. They must pass before release.

## Offline solver measurement after demand scaling

The recorded run uses Pi 1.1.0 and AA index 4.3. The frozen fixture contains
149 available registry models and 876 benchmark rows. It has per-axis provenance
and separate SHA-256 digests for both halves. It contains no credentials,
endpoint URLs or user preference/configuration values.

The fixture pool has no personal allowlist. The local pool applies the user's
allowlist and blacklist. Each row below covers five phases, with three runs per
phase and a prepared operator preference domain. Counts describe only this run.
The selector applies phase evidence requirements before comparison.

| Pool | Expanded actions | 200 ms, cap 4096: exact | 200 ms, no cap: exact | 500 ms, no cap: exact | 1000 ms, no cap: exact |
|---|---:|---:|---:|---:|---:|
| Frozen fixture, text | 673 | 0/15 | 0/15 | 12/15 | 15/15 |
| Frozen fixture, vision | 578 | 0/15 | 3/15 | 15/15 | 15/15 |
| Local allowlist, text | 168 | 0/15 | 12/15 | 15/15 | 15/15 |
| Local allowlist, vision | 160 | 0/15 | 15/15 | 15/15 | 15/15 |

All capped results used `spike-pair-cap`. All uncapped nonexact results used
`timeout`. The empty profile achieved exact results in every uncapped budget
sample. Cold operator-domain compilation, including worker start, took 80.8 ms
in one sample. Warm uncapped operator P95 was 628.1 ms for the broad text pool
and 237.7 ms for the local text pool.

These results reject an unreported 200 ms/4096 production assumption. The
approved production budget is 500 ms with no pair cap. At that deadline, the
broad fixture text pool can use the labeled central fallback.
The samples do not establish population P95/P99, cold-start distributions,
performance for every profile, or end-to-end solve-rate improvement.

To regenerate both fixture halves from a synchronized store:

```bash
PI8_POOL_STORE=/path/to/benchmarks.json npm run freeze:pool
```

This overwrites `fixtures/real-pool.json`. Review the resulting data before commit.
To measure actual selector outcomes without provider calls:

```bash
PI8_POOL_STORE=/path/to/benchmarks.json \
PI8_POOL_REPORT=/tmp/pi8-pool-report.txt npm run measure:pool
```

The report includes uncapped timings and actual results for each tested budget.
Missing local data leaves the local production-budget condition unmeasured.
Fixture-only measurements do not satisfy that condition.

## Verification of this preparation step

- `npm run tsc`: passed, including eval compilation.
- `timeout 900 npx vitest run`: 110 files passed and 2 skipped. 1896 tests passed
  and 3 skipped.
- `npm run measure:pool`: the opt-in measurement test passed.
- Removing an active row's provenance, while updating its digest, caused the
  fixture provenance test to fail. The correct fixture passed after removal
  of the mutation.

No production routing path changed. No model-provider calls were made by the
fixture generator or measurement. The requested oracle review produced no
review because the bridge failed to resolve its conversation. No substitute
advisor was used. Real Pi integration remains unverified for the new adapters.
