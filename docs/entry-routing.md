# Entry routing

[Overview](overview.md) · [Routing](routing.md)

Each genuine user entry starts in **triage**, routed as `gather`. A thin continuation such as “ok, do it” also starts in triage.

```text
User entry → triage (gather) → direct answer → settle
                         └→ ready handoff → selected task → settle
```

The last actually served model remains an incumbent candidate. Continuity and eligible warm-cache evidence can favor it. Its earlier task type, thinking minimum, contract, and mutation authority do not apply to a new entry.

## Context collection

Triage permits evidence collection and a direct answer. An investigation, plan, review, or implementation that needs another selection uses a ready handoff. Source-dependent ratings require inspected source; an unknown source location is missing evidence, not a design decision.

Recognized mutations and execution plans are refused before an accepted boundary has been served. A `ready-pending` boundary does not authorize the model that called the handoff to edit. The entry gate runs before mutation observation and contract bookkeeping.

Mutation detection is best-effort. The gate is a workflow control, not a filesystem security sandbox.

Two counted refusals move the entry to `clarification-only`. Invalid declaration shapes do not consume this budget. Collection also has a bounded provider-request budget. Clarification-only permits one question to the user without tools.

## Declaration tools

| Tool | Purpose |
|---|---|
| `hand_off_context` | Transfer the next step with `ready`, or request missing input with `needs-user`. |
| `commit_execution` | Submit a closed execution plan for changes that the user authorized. |

The extension registers these two tools. Their current on/off note determines whether they apply. They have no routing effect in concrete-model sessions.

A direct answer needs no declaration or second selector pass. The caller does not declare completion or select tracked work.

## Handoff declarations

A ready handoff declares `deliverable`, `complexity`, and `scope`. Supported task types are `gather`, `plan`, `implement`, and `review`. A `gather` handoff selects an investigator with the declared demand; it can follow another gather boundary.

Repeated accepted payloads are idempotent. A materially different accepted payload creates another boundary in the same entry. Prepared facts must still belong to the active entry, boundary, routing epoch, and session generation when submitted.

A plan-only or review-only request does not authorize implementation. Accepted implementation handoffs include guidance to specify a closed plan before editing. This guidance does not itself create a contract.

For ratings:

- `facts.decisions` names unresolved behavior, interface, or design choices.
- `facts.unknowns` names missing evidence.
- The rubric rates only the remaining work.
- Omitted rubric criteria inherit the highest supplied level.

## Referenced source evidence

Supported explicit `@file` references in the current entry create source obligations. Declared file lists do not prove that a source was read. Earlier entries and earlier task state supply no read credit.

Native reads and supported tool-result content accumulate line coverage for one SHA-256 file version. Partial or truncated output cannot establish a whole-file read. A content change resets the applicable coverage. An own edit refreshes an observation only after a complete read; a write cannot establish a read.

The router rechecks freshness before handoff, recognized mutations, execution plans, and settlement, even when an earlier read satisfied the obligation. Missing paths, directory scopes, and files above the grounding size cap retain their read exemptions. Diagnostics record counts, not paths or content.

A direct answer with an unmet source cannot settle as source-grounded. A hidden continuation asks for the full current source in the same entry. After two unresolved source-settle attempts, the entry enters clarification-only and asks the model to state the limitation and request the missing input. A successful full read permits settlement without a handoff. An ordinary direct answer has no completion reminder.

## Execution plans

The model uses `commit_execution` after it specifies every remaining change and verification command.

A plan contains up to 12 steps:

| Step | Required information |
|---|---|
| `edit` | A concrete file path and the exact change |
| `create` | A concrete file path and the complete creation requirements |
| `delete` | A concrete file path |
| `verify` | `test`, `typecheck`, `lint`, or `build`, with the intended scope |

File patterns are not valid targets. A plan must resolve behavior and interface choices before another model executes it.

The execution rubric rates five criteria from 1 to 5:

1. Open decisions.
2. Spread across files or modules.
3. Verification difficulty.
4. Knowledge outside the listed files.
5. Coupling to other behavior.

The router also measures target count, directories, source size, and recent fix history.

The plan resolves the decisions that made the original request difficult.

## Demand formulas

The implementation rubric uses `openDecisions`, `spread`, `verification`, `knowledge`, and `coupling`.

The reasoning rubric uses `alternatives`, `stakes`, `spread`, `knowledge`, and `uncertainty`.

Each level ranges from 1 to 5. The router maps each level to `(level − 1) / 4`. Missing or invalid levels in a partly scored rubric inherit its highest valid level.

### Rubric demand

Independent requirements use their maximum:

```text
implementation:
  reasoning = max(openDecisions, knowledge, coupling)
  agentic   = clamp01(max(openDecisions, spread, verification, coupling) + measuredDemand)
  research  = max(openDecisions, knowledge)

reasoning:
  reasoning = max(alternatives, stakes, knowledge, uncertainty)
  agentic   = clamp01(max(spread, stakes, uncertainty) + measuredDemand)
  research  = max(knowledge, uncertainty)
```

File measurements supplement agentic demand by at most 0.20 (0.05 per metric):

```text
measuredDemand = 0.05 × (filesScore + directoriesScore + linesScore + fixesScore)
```

| Measurement | Full contribution at | Score formula |
|---|---|---|
| Files | 5 files | `clamp01((files − 1) / 4)` |
| Directories | 4 directories | `clamp01((directories − 1) / 3)` |
| Existing lines | 4,000 lines | `clamp01(log2(max(lines, 1) / 250) / 4)` |
| Fix commits (180 days) | 5 fixes | `clamp01(fixes / 5)` |

Failed applicable measurements contribute their maximum (0.05 each). Declarations without source-file evidence receive no measurement addition.

### Coarse complexity bounds

Without a rubric, a declared complexity band supplies demand bounds for each axis:

| Complexity | Lower | Central | Upper |
|---|---:|---:|---:|
| `trivial` | 0 | 0 | 0.125 |
| `routine` | 0.125 | 0.25 | 0.375 |
| `moderate` | 0.375 | 0.50 | 0.625 |
| `hard` | 0.625 | 0.75 | 0.875 |
| `frontier` | 0.875 | 1 | 1 |

File measurements add to the agentic center and bounds. An open-ended scope keeps the agentic upper bound at 1 when no rubric is provided.

Without a rubric or complexity declaration, demand spans the full uncertainty interval `[0, 1]` with center 0.5.

## When the submitter retains a plan

Acceptance does not guarantee transfer to another model.

A plan is released to the executor chosen by the selector unless it is unsafe or unfinished for another model:

- `size`: The plan has more than 2 target files or more than 4 steps.
- `unknown-target`: A declared target is missing or its line count could not be measured.
- `delete`: The plan contains a file deletion step.
- `open-decisions`: The execution rubric leaves `openDecisions` at 4 or 5.

Benchmark quality and task difficulty do not keep a plan. When released, the selector evaluates executor candidates with the plan's rubric.

A retained plan continues as `implement` with incumbent minimums in force.

See `/router-why` for the retention reason.

## Execution and review

```text
Submit a plan
     |
Release to an executor, or retain the submitter
     |
Execute declared edits
     |
Another model executed the plan?
     | yes                     | no
Submitter reviews          Continue implementation
```

Successful native `edit` and `write` calls count toward declared targets. Shell writes do not count as target completion.

The contract reaches execution completion after all edit/create targets succeed or its invocation budget expires.

The invocation budget is `2 × steps + 4`. Shell writes and deletions do not count toward target completion.

The executor is the first different model to serve a released plan. Release can still select the submitter through scoring or fallback.

If another model executed the plan, the next invocation normally returns to the submitter as `review`.

A temporary submitter selected through escalation or fallback does not own that review. The router selects the reviewer independently.

Verification steps after the last declared edit therefore run during review. Contract execution completion does not mean that tests passed.

## Broken plans and execution flows

A plan breaks when its executor edits an undeclared target, submits another plan during execution, or triggers an objective-struggle handoff. A new plan during review is rework. Breaks and rework can add strikes to the executor.

Strikes belong to an **execution flow**, not a durable task record. A materially different implementation handoff in the same entry retains the flow. A new accepted execution plan does not reset its strikes.

At two strikes, the flow excludes the canonical `provider/model` from implementation at every effort. The same model ID on another provider is a different executor. Plan, review, and gather selections do not inherit an implementation exclusion.

When an entry ends, a flow with strikes or exclusions is offered only to the immediately following entry. Its triage note shows the relevant identities and counts. It does not establish task type, effort minimum, ownership, or mutation authority.

That next entry adopts the flow only through `hand_off_context(ready, implement, continuesFlow=true)`. Omission or `false` starts a fresh implementation flow. An unrelated answer discards the offered flow when its entry ends. A declaration cannot skip an entry to recover an earlier flow. If no previous flow exists, `continuesFlow=true` starts fresh and reports this fact. The field is invalid with other outcomes or task types.

A contract ends when its entry settles or another entry starts. Outcomes distinguish `clean`, `fixed`, `rework`, `broken`, and `unfinished`. The first verifier after execution records its result separately; execution completion does not prove that checks passed.

## Observed change facts

Handoff tools can accept optional `facts`. These describe observed evidence, not an additional authorization to change files.

Lists record check commands and state, changed/created files, precedent, decisions, unknowns, outside dependencies, irreversible effects, and domains.

`commit_execution` derives changed files and checks from its steps.

Answers use `Y`, `N`, or `U` for these properties:

- The request reports a defect.
- The work changes existing behavior.
- The work converts between formats or schemas.
- Correctness depends on ordering, retries, timing, or concurrency.
- The work depends on undescribed outside behavior.
- A reported defect has no reproduction.
- Success depends on appearance or performance.
- The work changes security or stored-data handling.

Each statement includes its conditions. An absent condition means `N`. Insufficient inspected evidence means `U`.

Contradictory answers become unknown. Examples include a rewrite with no modified files or a missing reproduction without a reported defect.

The router records ignored-answer codes, not the supplied text.

A separate measurement pass uses one three-second deadline. It inspects size, history, references, test coverage, checking tools, precedent, and pre-handoff reads.

Failed measurements remain unknown in this pass. This differs from the conservative failure rule in the active rubric calculation.

The facts requirement starts at the task default. Known facts can change it. Unknown facts cannot.

Check quality, appearance, performance, reproduction, security, stored data, and irreversible effects do not change that shadow requirement.

The facts requirement is diagnostic only. Routing does not consume it.

Verifier records retain the last result before and after the handoff, plus run counts. Results distinguish pass, fail, and timeout.

An explicit failure count determines the result. Without a count, failure words can identify failure.

A passing test name that contains “failure” does not override a reported zero-failure count.

## Session and branch transitions

`EntryRoutingState` owns the live entry and its accepted boundaries. `EntryEvidenceState` owns current-entry source obligations and observations. `ServingHistoryState` remembers only the branch's last actually served provider/model and optional effort.

A narrow `pi8-serving-v1` event records a change of served identity. Repeated serves by the same identity need no event. Pi model selections and `pi8-model-selection-v1` records clear or establish selection in branch order. Opening or navigating a branch without a request writes nothing.

Legacy `pi8-routing-context-v1` incumbent records can seed serving identity read-only. Their task type, work fields, status, penalties, and grounding cannot establish entry authority. Session files are not rewritten.

Tree navigation, session reset/resume, and ownership-changing model transitions advance the process-local routing epoch before restoring state. They clear source evidence, live and previous flows, contract authority, pending preparation, and boundary authorization. Tree navigation clears warm caches and rebuilds only serving identity and request notes. A restored serving identity is not evidence of a warm cache hit or an in-flight contract.

Decision-log schema 5 uses `routingScope` for entry, boundary, assignment, and optional flow identities. It writes acquisition settlement records rather than a work lifecycle. Findings, questions, paths, and source content are not decision-log fields.

[Entry state](../extensions/routing/policy/entry-routing-state.ts) · [Source evidence](../extensions/serve/entry-evidence.ts) · [Contract tracking](../extensions/serve/execution-contract-tool.ts)
