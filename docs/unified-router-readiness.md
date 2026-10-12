# Unified routing readiness

## Current implementation

The production provider uses the unified selector for model and effort selection.
It creates work-item and phase permissions before comparison, checks them before
dispatch, and settles pending handoffs and contract releases after actual serve.
Empty preferences use the default coefficient domain.

In-provider pre-output recovery still uses the existing selection path.
Automatic subagent integration is disabled and excluded from the cutover;
its inactive implementation files remain. Tests cover the disconnected hooks,
not child selection. The preference command, full transactional reservation,
legacy state migration and production Pi host exit checks remain incomplete. This is
not a complete production release.

The following modules have executable offline tests:

- Effective-action enumeration and per-axis benchmark provenance.
- Candidate features, cache accounting and AA output-equivalent demand scaling.
- Task difficulty from the handoff or plan rubric and router measurements
  (`feature-v2`): it scales capability relevance and cost sensitivity continuously.
- Preference validation, scenarios, domain identity and exact regret selection.
- Transactional assignment, preparation fallback through the retained ranking,
  recovery consumption and single-use dispatch.
- Explicit actor authorization and on-demand pre-output intervention.

Two policy decisions are settled:

1. An explicitly authorized actor settles a boundary only after actual serve.
   Fallback membership and higher effort grant no authorization.
2. Pre-output intervention awaits the shared selector on demand. The final
   output check, abort and reservation form one atomic operation.

Controlled-port tests and provider orchestration tests cover these modules.
They do not establish complete Pi integration coverage. `/router-preferences`
and its optional setup notice are not implemented. Preference storage and
notice-state helpers exist.

## Work-item and phase permissions

`allowedActors` is the callable action pool for one work item, phase and
assignment. It is not a second capability assessment. Task difficulty,
benchmark quality, price and preferences affect selection only.

The unified assignment host calls `AssignmentLedger.authorize(phase, keys,
workState)` with the effective action keys that pass availability and other
hard restrictions. An implementation failure excludes that model at all its
efforts only for the same work item and implementation phase. The model can
still compete in planning and review. A different work item does not inherit
that exclusion. A quota restriction removes the model from the callable input
pool in every phase while the restriction applies.

The host passes `plan.allowedActors` to `selectByRegret` in its controls. The
selector filters before feature extraction and regret comparison. Reservation,
dispatch and preparation fallback check the same permissions. An empty list
means no permitted action, not unrestricted access.

A change of work item, branch, session generation or authorization revision
expires the permission snapshot. Each new authorization has a new assignment
identity. Actual-serve receipts must match the work item, phase, boundary,
assignment and revision. A failed attempt, stale receipt or unauthorized model
cannot settle the boundary or release a pending contract.

The production provider applies these permissions to ordinary routing and
execution contracts. A contract that returns to its submitter permits only that
submitter; failed dispatch leaves the return pending. An open behavior, interface
or design choice also keeps a plan with its submitter. Benchmark quality and task
difficulty do not change this release permission.

Provider tests cover legal fallback settlement, excluded executors, pending
returns, cancellation, stale preferences and unchanged-snapshot manual resume.
Complete single-use reservation and branch restoration checks remain release
conditions.

## Conditions before runtime migration

| Condition | Current evidence | Required evidence |
|---|---|---|
| Controlled prepared dispatch | The integration policy is settled and uses only the installed public API. Maintained Pi 1.1.0 SDK probes cover each point: pre-run preparation fallback with a compaction attempt limit, in-run compaction against an advertised target window, and `ctx.abort()` in the context hook. Throwing from that hook does not prevent dispatch. | Implement the policy in the production adapter, with a complete-request estimate. Restrict operational fallback and recovery inside one provider call to targets that hold the prepared prompt. Resolve physical-target compaction overrides. |
| Feasible summary route | Native virtual routing can use a fitting larger model for summaries. Direct switching to a smaller model can send an oversized summary request to that model. | Validate the actual summary action's capacity and accounting. Failed, disabled or cancelled compaction must send no oversized request to the selected target. |
| Production selection budget | Approved: 500 ms in total with no pair cap (`PRODUCTION_SOLVER_BUDGET`). The allowlisted pool solved exactly in every recorded 500 ms sample. | Validate cold starts and representative profiles in the production adapter. |
| Preference command | Schema, persisted profile snapshots and domain compilation exist. | Implement the five-question command, truthful applied/softened/nonbinding status and nonblocking one-time interactive notice. Make no provider calls. |
| Pi host mechanism tests | Maintained SDK tests cover pre-run preparation fallback, context preparation, final abort guards, after-tool checks, manual compaction ordering, cancellation and file-backed resume. Controlled-port tests also exist. | Add production adapter coverage for asynchronous provider selection and each operational fallback. Child-selection integration is excluded. |

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

Full prepared-dispatch, settlement, recovery and resume tests
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

## Verification of the provider integration

- `npm run tsc`: passed, including eval compilation.
- `timeout 300 npx vitest run`: 112 files passed and 2 skipped. 1872 tests passed
  and 3 skipped.
- Six production selection adapter tests cover effort enumeration, thinking
  minimums, smaller-window retention, scoped exclusions, stale profiles and
  cancellation.
- Removing the live preference-digest check caused the stale-profile test to
  fail. Classifying higher effort on the same model as unavailable caused the
  recovery test to fail. Both tests passed after restoration.
- Estimated fixture axes remain estimated unless they declare measured
  provenance explicitly.
- Active subagent hooks preserve caller arguments and perform no role selection
  or child credential sweep. Child results do not change parent exclusions.
  Enabling injection or removing the result guard makes these tests fail.
- Elicitation fixture projects use `node:test` and are excluded from Vitest
  discovery without changing their files.

Provider tests use scripted streams. They make no model-provider calls. No
subagent was started. The new production adapters still need the Pi host exit
checks above. Pre-output recovery and preference UI remain incomplete.
Subagent selection is excluded from this cutover.
