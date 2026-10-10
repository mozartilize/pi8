# Subagents

[Overview](overview.md) · [Routing](routing.md)

pi8 can supply concrete models to [pi-subagents](https://www.npmjs.com/package/pi-subagents) calls. The router does not grant permission to delegate work.

The parent must still follow the user's delegation instructions and the subagent tool's execution rules.

## Role minimums

| Role | Minimum task type |
|---|---|
| `researcher` | `plan` |
| `planner` | `plan` |
| `worker` | `implement` |
| `reviewer` | `review` |
| `advisor` | `plan` |

A role minimum is a task-type constraint. It is not a capability tier or a thinking level.

At spawn time, the router scores each visible structured child. Selection uses its role, task, configured weights, and context constraints.

Role selection uses `legacy` scoring even when main turns use `cheapest-sufficient`. See [Configuration](configuration.md#default-scoring-weights) for applicable weights.

The router keeps reviewer selections independent from the selected worker's model family.

Use this command to inspect resolved role models:

```text
/router-agents
```

## Explicit models and pins

An explicit child model takes precedence over automatic injection. User and project role pins also take precedence.

The router injects a model into the spawn request. It does not save these choices in Pi's settings files.

A child with a concrete model does not change models during its process.

## Workflow scripts

The router can inspect structured child specifications. It does not parse JavaScript workflow strings to infer each child's task.

For an opaque workflow script, the router supplies only the tool-level default model. The default role order is:

1. `worker`.
2. `planner`.
3. `researcher`.
4. `advisor`.
5. `reviewer`.

An explicit model inside the script still takes precedence. Do not assume that an opaque script receives task-specific routing for every child.

Use the installed pi-subagents documentation for workflow syntax and isolation rules.

## Authentication and failures

The router prepares role candidates from the registry and saved benchmarks.

A credential probe excludes unauthenticated providers before role assignment. This probe has a three-second timeout.

That timeout is separate from delegation. Main-stream delegation has no authentication or output deadline.

If the entire credential probe fails, authentication remains unknown. The router omits injection instead of claiming that authentication succeeded.

A foreground child that reports a provider usage limit excludes that provider for the current session.

The exclusion also affects later main turns and child spawns. Ordinary transient child failures do not create this persistent provider exclusion.

The router does not respawn a failed child. The parent decides recovery under the user's instructions.

After restoring provider access, remove the session exclusion:

```text
/router-blacklist remove <provider>/*
```

## Cost coverage

The router can include priced foreground child usage in `/router-report`.

Async children do not return final usage to the parent for this report. Their costs are absent, not zero.

See [Observability](observability.md#cost-report) before comparing reports.

## Sources

- [Role minimums](../extensions/types.ts)
- [Subagent model injection](../extensions/agents/subagents.ts)
- [Foreground child spend](../extensions/agents/subagent-spend.ts)
