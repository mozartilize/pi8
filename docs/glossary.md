# Glossary

[Overview](overview.md) · [Routing](routing.md)

Use these terms consistently in issues, documentation, and model-facing instructions.

| Term | Meaning |
|---|---|
| Task type | The kind of work: `lightweight`, `gather`, `plan`, `implement`, or `review`. Code uses `Dimension`. |
| Capability tier | Eligibility class: meets every minimum, has unknown quality, or has a measured failure. |
| Capability band | Named requirement range used by legacy routing: `economy`, `standard`, `strong`, or `frontier`. |
| Requirement | A normalized capability value that determines required benchmark minimums. |
| Capability minimum | A required measurement value for the task and input shape. |
| Handoff minimum | Requirement that applies after an accepted task declaration. |
| Executor minimum | Implementation requirement that applies to a released execution plan. |
| Incumbent capability minimum | Constraint that preserves the serving model's measured capability between routing boundaries. |
| Minimum thinking level | Constraint that preserves the effort the incumbent actually served. |
| Candidate | One routable provider, model, and effort combination. |
| Candidate key | The identity `provider/id[:effort]` used in routing and logs. |
| Effort | A provider-supported thinking level, such as `low`, `high`, or `max`. |
| Estimated quality | A conservative inferred value, not a measurement at the candidate's exact model and effort. |
| Incumbent | The model that retains the current routing phase. |
| Final step | The requested outcome declared through task type, complexity, and scope. |
| Terminal event | A stream event that ends one model attempt. This is not a task's final step. |
| User entry | One user request and its associated tool-loop continuations. |
| Work item | Tracked work that can continue, complete, or reopen across user entries. |
| Handoff | An accepted declaration that transfers work to its next routing phase. |
| Execution contract | An accepted closed plan with concrete changes and verification steps. |
| Submitter | The model that submits an execution plan. |
| Executor | A different model that serves a released plan. |
| Release | Permission for routing to select an executor without the submitter's incumbent minimums. |
| Retained plan | An accepted plan that stays with its submitter. |
| Strike | A counted failure. Executor strikes and provider strikes have different rules. |
| Trajectory friction | Observable struggle, such as repeated actions or persistent verifier failures. Code uses TFI. |
| Escalation | A routing decision that selects a strictly stronger candidate after objective struggle. |
| Fallback chain | Ordered candidates available for safe recovery from provider failures. |
| Replay | Repetition of an attempt on another candidate before output makes repetition unsafe. |
| Manual pin | A session-only model override that prevents fallback to another model. |
| Sidecar | A log file beside Pi's saved session transcript. |
| Baseline spend | Counterfactual token cost at a comparison model's registry rates. It is not an observed alternative run. |
| Synthetic message | Integration text that does not start a new user entry. |
| Session generation | Identity that changes on reset. Asynchronous state writes must belong to the active generation. |
| Provenance | Label identifying user, assistant, summary, or recognized synthetic text. |
| Provider circuit | Provider-health counter that excludes remaining sibling models after three strikes. |
| Seam | Deliberate test hook for a path, retry delay, or runtime dependency. |

## Minimum subjects

| Minimum | Subject |
|---|---|
| Role minimum task type | The kind of work a subagent role must receive |
| Capability minimum | Measured quality required by task type and input shape |
| Handoff minimum | Rubric and final-step requirement after an accepted declaration |
| Executor minimum | Rubric, measurements, and shape of a closed execution plan |
| Incumbent capability minimum | Serving-model quality retained between boundaries |
| Minimum thinking level | Effort that the incumbent actually served |

A change in task type is not a change in capability tier. Final-step and executor bands use different thresholds.

See [Scoring](scoring.md#incumbent-minimums) and [Work lifecycle](work-lifecycle.md#requirement-formulas) for the rules.

## Benchmark names

- **Intelligence:** Artificial Analysis Intelligence Index.
- **Agentic coding:** Terminal-Bench 4.0 pass rate in percent.
- **AA Agentic Index:** Artificial Analysis's separate agentic index.
- **Omniscience:** An index for closed-book correctness.
- **Briefcase:** A benchmark for work from source files, measured against deliverable checks.
- **LCR:** The long-context correctness measurement used by the router.
- **MMMU-Pro:** The vision-reasoning measurement used by the router.

Do not use “floor” without naming the specific minimum. Do not use task type, capability tier, and capability band as interchangeable names.
