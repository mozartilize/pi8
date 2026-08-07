---
name: route-up
description: Use when you are serving a conversation through router/auto and the
current task appears to need deeper reasoning, planning, architecture, design
research, or open-ended investigation than the current model is suited for.
Also use when the user expresses dissatisfaction with answer depth, or
when a task that looked trivial turns out to require multi-step analysis.
---

# Route Up

You were selected automatically to serve this main-conversation turn. The
router classifies prompts with keyword heuristics, which can under-estimate
tasks phrased conversationally.

Call the `route_up` tool BEFORE writing a substantive answer when the task
needs a stronger model beyond your capabilities for:

- deeper reasoning, design-space research, architecture, API design,
  trade-off analysis, or open-ended investigation;
- multi-step planning across files or systems;
- a deep question for which you are producing a shallow answer; or
- a user who pushed back on a previous answer's depth or quality.

Pick the dimension that fits (`plan` for design/architecture/research,
`review` for critique, `implement` for substantial coding, or `gather` for
deep codebase reading) and give a one-sentence reason. Then briefly restate
what you understood so the stronger model has a clean handoff.

Do NOT call it for tasks you can genuinely handle: summaries, renames, small
edits, factual lookups, or formatting.

## Router behavior and boundaries

The invocation guidance above matches the rules injected inline into every
eligible `router/auto` model. After an accepted call, the router's next provider
invocation re-scores the requested dimension. If the request is already at the
top/effective dimension, it can quality-first repick a different model in that
same dimension; `plan` is therefore still actionable when an alternative
exists. This explicit pre-answer handoff is not a semantic-quality detector or
an automatic replay after visible text or task tool calls.

A subagent already runs with a concrete model and cannot switch that model in
place. If your subagent task contains a `Router escalation contract`, follow
that contract before producing substantive output instead of expecting
`route_up` to replace you transparently. The router can only give the parent a
one-shot retry directive; the parent must synchronously respawn the same role
and task without an explicit model. Explicit model choices and user-pinned
roles always win.
