# Work lifecycle

[Overview](overview.md) · [Routing](routing.md)

This guide explains how a model declares, executes, and completes work. The tools are model-facing, not slash commands for users.

## Context collection

A request with no incumbent starts as `gather`.

During collection, the model can use trusted readers, ask a question, and declare the next step. Shell runners and mutations remain blocked.

Source-dependent ratings require source inspection. A model must not rate an unknown source location as a design decision.

The gathering gate is a workflow control. It is not a security sandbox.

A refused mutation or subagent call counts against collection. A handoff rejected because referenced files were not read also counts.

Two counted refusals move the entry to `clarification-only`. The model can then ask the user, but cannot continue collection.

An invalid handoff shape does not count as a refusal. The model can update its fields and submit again.

Collection also has a request budget. A direct-answer declaration creates no work item or incumbent.

An incumbent serves later entries at its task type until an accepted boundary changes it.

## Router tools

| Tool | Purpose |
|---|---|
| `hand_off_context` | Declare a direct answer, ask the user, or transfer a request to its next task type. |
| `routing_context` | Update the title, summary, and anchors for the current work. |
| `commit_execution` | Submit a closed execution plan for authorized changes. |
| `complete_work` | Close completed or superseded work. |
| `reopen_work` | Continue the completed work item owned by the current model. |

These tools apply only when the latest router note enables them. Calls outside `router/auto` do not activate routing work.

`routing_context` records metadata. It does not select a model.

The extension registers all five tools once. Session and model-selection hooks add missing names without removing other active tools.

Switching between automatic and concrete models changes the tools note, not the tool set. This preserves the provider's cached prompt prefix.

A request carries an on/off tools note only when the latest note needs replacement. Tools refuse calls outside automatic routing.

Accepted implementation handoffs and reopenings include guidance to submit a closed plan before editing.

That guidance does not create a contract, change minimums, or count as an edit reminder.

Under eligible plan/review or raised-minimum implementation conditions, an unplanned native edit or write can receive one reminder.

Appending the reminder to a tool result preserves the transcript prefix. Reminder and acceptance records support protocol counts.

## Handoff declarations

A ready handoff declares the task type, complexity, scope, and work-item relation.

The router grounds referenced files against the model's reads. Missing evidence can prevent acceptance.

For ratings:

- `facts.decisions` names unresolved behavior, interface, or design choices.
- `facts.unknowns` names missing evidence.
- The rubric describes only the remaining work.
- Omitted criteria inherit the highest supplied level.

A direct answer needs no execution plan. A plan-only or review-only request does not authorize implementation.

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

The final step does not increase the executor minimum. The plan resolves the decisions that made the original request difficult.

## Requirement formulas

The implementation rubric uses `openDecisions`, `spread`, `verification`, `knowledge`, and `coupling`.

The reasoning rubric uses `alternatives`, `stakes`, `spread`, `knowledge`, and `uncertainty`.

Each level ranges from 1 to 5. Missing or invalid levels in a partly scored rubric inherit its highest valid level.

Without a valid scored criterion, task defaults apply instead of a rubric calculation.

### Rubric calculation

```text
implementation = min(1, 0.30 + open-decision addition
                     + other criterion additions + measurement additions)
reasoning      = min(1, 0.40 + alternatives addition
                     + other criterion additions + measurement additions)
```

| Level | Open-decision addition | Alternatives addition |
|---|---:|---:|
| 1 | 0 | 0 |
| 2 | 0.10 | 0.06 |
| 3 | 0.25 | 0.18 |
| 4 | 0.42 | 0.34 |
| 5 | 0.60 | 0.46 |

Each remaining criterion adds `0.08 × (level − 1) / 4`.

The router normalizes four source measurements to values between zero and one:

| Measurement | Normalized value before clamping |
|---|---|
| Files | `(files − 1) / 4` |
| Directories | `(directories − 1) / 3` |
| Existing lines | `log2(max(lines, 1) / 250) / 4` |
| Fix commits in the last 180 days | `fixes / 5` |

Each measurement contributes at most 0.04 for implementation or 0.03 for reasoning.

A failed applicable measurement contributes its maximum. A handoff without source-file evidence receives no source-measurement addition.

The router records step count, commit count, and test-target count. They are not additional weighted terms in this formula.

These weights are hand-set. Logged rubrics, measurements, and outcomes support fitting, but do not prove task sufficiency.

### Final-step calculation

A ready handoff or reopening declares its final step through task type, complexity, and scope.

```text
final-step requirement = clamp01(kind base + 0.5 × complexity value
                                 + open-ended scope addition)
```

| Task type | Kind base |
|---|---:|
| `lightweight` | 0.10 |
| `gather` | 0.20 |
| `implement`, `review` | 0.30 |
| `plan` | 0.35 |

Complexity values are `trivial: 0`, `routine: 0.25`, `moderate: 0.50`, `hard: 0.75`, and `frontier: 1`.

Open-ended scope adds 0.10. Bounded scope adds nothing.

Within an entry, a stronger final-step declaration replaces a weaker one. A weaker declaration cannot reduce it.

Under `legacy`, the final step maps to these bands:

| Band | Final-step requirement | Handoff minimum |
|---|---|---:|
| `economy` | Below 0.30 | None |
| `standard` | From 0.30, below 0.50 | 0.45 |
| `strong` | From 0.50, below 0.75 | 0.70 |
| `frontier` | At least 0.75 | 0.85 |

The handoff takes the higher of the capped rubric requirement and final-step minimum.

The rubric ceiling is 0.65 for bounded implementation with `openDecisions` at most 3. Other handoffs use 0.85.

Without a scored rubric, defaults apply. Only a final step above the task default raises the requirement.

The evaluation comparator uses the final-step requirement directly, not named bands. It cannot lower task defaults.

A strong or frontier gather entry receives its handoff reminder on the first tool result. The comparator uses a final-step requirement of at least 0.50.

### Executor calculation

A closed plan does not inherit the final-step increase. The router uses the implementation rubric, target measurements, and plan shape.

The legacy executor bands differ from final-step bands:

| Executor band | Computed requirement | Minimum |
|---|---|---:|
| `economy` | Below 0.45 | 0.30 |
| `standard` | From 0.45, below 0.70 | 0.45 |
| `strong` | From 0.70, below 0.85 | 0.70 |
| Retain submitter | At least 0.85 | No release |

The executor minimum is the higher of the computed requirement and band minimum.

More than two files or four steps requires at least `standard`. More than five files or eight steps retains the submitter.

Each excluded executor raises the legacy release band one step. The comparator uses direct shape requirements and measured stronger-replacement checks.

An accepted release skips incumbent capability and thinking minimums. A retained plan keeps both.

## When the submitter retains a plan

Acceptance does not guarantee transfer to another model.

The submitter retains a plan when:

- The plan is too large for release.
- A required edit or delete target is missing or cannot be checked.
- The plan deletes a file.
- The requirement is too high for release.
- An executor exclusion prevents release.
- The rubric leaves a behavior, interface, or design choice open.
- The executor minimum exceeds the submitter's measured quality.

`openDecisions` of 4 or 5 indicates an open choice. Existing retention reasons can take precedence in the log.

The measured-quality check uses the implementation axis selected by the active policy and requirement.

Missing or estimated submitter quality does not trigger that check. Unknown quality does not count as weak quality.

A retained plan continues as `implement` with incumbent minimums in force. Ordinary struggle detection can still request recovery or escalation.

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

## Broken plans and rework

A plan breaks when the executor:

- Edits an undeclared file.
- Submits another execution plan during execution.
- Triggers a pending objective struggle handoff.

The breaking call is not a filesystem security barrier. The next invocation returns the work to the submitter, subject to pending escalation.

A new plan during review is rework. Breaks and rework count against another model that executed the plan.

After two strikes, the router excludes that executor identity for the work item. Later release requires evidence of a strictly stronger replacement.

Strikes carry across entries and reopening of the same item. Active contracts do not.

An excluded model remains excluded at every effort and provider. Replacement requires measured implementation quality above the strongest excluded executor.

Legacy band increases limit repeated release after exclusions. Missing stronger evidence retains the submitter.

A contract ends when the entry settles or a queued entry starts. The log assigns one outcome:

| Outcome | Meaning |
|---|---|
| `clean` | No edits during review |
| `fixed` | The submitter edited during review |
| `rework` | Review submitted another plan |
| `broken` | The execution contract broke |
| `unfinished` | The entry ended with an active contract |

The first verifier after execution records `pass` or `fail`. This record is separate from the contract outcome.

## Completion and reopening

The model calls `complete_work` only when the user's request is complete.

Optional suggestions do not keep the item open. Unfinished requirements, necessary user input, and unfixed test failures do.

Completion preserves the conversation and serving model. A follow-up question can receive a direct answer.

Further changes to the same completed item require `reopen_work`. Different work uses `hand_off_context` for another item.

`reopen_work` grounds referenced files again and permits a new routing decision.

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

## Completion records and reminders

`complete_work` writes `work-close` and the `work-complete` boundary in one `context-commit` before changing entry-local state.

It affects only the active item. It rejects `done` while an execution contract remains active or broken.

Supersession does not claim successful execution.

A completed-work gate blocks mutations, execution plans, and subagent calls until a valid handoff or reopening.

These refusals do not count against acquisition. Questions about completed work remain answerable without reopening.

`hand_off_context` refuses selection of the completed item owned by the entry. This does not count as an acquisition refusal. That item uses `reopen_work`.

Reopening checks currentness, grounds files, and records its transition in one commit. Acceptance permits one repick and associates the incumbent with the reopened item.

Before a run ends, the router can issue one hidden settle reminder and continue once.

An unresolved collection phase can receive a handoff reminder. Implemented changes or delivered plan/review work can receive a completion reminder.

If the model still omits the required declaration, context remains unresolved or work remains open. Answers do not replay solely for a missing handoff.

Work choices and settle reminders enter delegated requests, not the system prompt or Pi transcript.

## Session and branch transitions

`requestRouting` reads model selection on the active transcript branch. It identifies routed requests through model selection or a matching router event.

Pi records model switches as `model_change`.

When Pi does not record a selection, `before_agent_start` records `pi8-model-selection-v1` before Pi stores the request.

This covers command-line resume choices and tree navigation onto another model's branch. Opening a session or navigating without a request writes nothing.

A request under another model ends the active-item association without closing the item. The next routed entry gathers context and selects work again.

Earlier requests outside routing remain available for lexical work search as `l_n` choices. The index rebuilds only after a new such request.

Stored `migration-init` records retain no active state. The router reads them but does not write them.

Tree navigation carries task type and final-step constraints conservatively. Contracts, exclusions, strikes, handoffs, and collection state remain on their source branch.

[Work-phase source](../extensions/routing/policy/work-phase.ts) · [Contract tracking](../extensions/serve/execution-contract-tool.ts)
