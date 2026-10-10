# Command reference

[Overview](overview.md) · [Configuration](configuration.md)

Enter these commands in Pi, not in a shell. Replace angle-bracket arguments with actual values.

## Inspection

| Command | Result |
|---|---|
| `/router-status` | Data freshness, benchmark coverage, pin state, protocol counts, and the last decision |
| `/router-why` | Details of the last model selection and execution plan |
| `/router-report` | Estimated routed spend, baseline spend, and counts by task type |
| `/router-models` | Automatic allowlist and matching registry models |
| `/router-agents` | Resolved model for each supported subagent role |

`/router-report` is not an invoice or an outcome benchmark. See [Observability](observability.md#cost-report).

`/router-models` reports allowlist matches. It does not promise that each matched model can serve a request.

## Benchmark sync

```text
/router-sync [key]
```

The command refreshes the saved benchmark store. An explicit key becomes the saved configuration key.

Without an argument, sync checks `ARTIFICIAL_ANALYSIS_API_KEY`, then the saved key.

Chromium must be available. A failed source fetch preserves the previous benchmark store.

## Model mapping

```text
/router-fix <benchmark-slug> <provider/id>
```

This command saves a benchmark alias. The command does not immediately rematch the benchmark rows.

1. Read the unresolved slug from `/router-status`.
2. Check the destination identifier against Pi's registry.
3. Save the alias with `/router-fix`.
4. Run `/router-sync` to apply the alias.

See [Benchmark data](benchmark-data.md#model-matching) for matching limits.

## Manual model control

```text
/router-manual
/router-manual <provider/model[:thinking]>
/router-manual resume
```

Without an argument, the interactive command opens Pi's model picker. Argument completion supplies searchable model identifiers.

A pin keeps `router/auto` active. It exists only in the current router session. It does not change Pi settings or pi8 configuration.

A pinned request has no fallback to another model. Normal retries on the pinned model can still occur.

The picker follows Pi's available models. It does not apply automatic routing's allowlist or blacklist.

`resume` removes the pin. The next routed entry reuses the saved pre-pin route when that route remains usable.

Later entries route normally. If no saved route remains usable, ordinary routing resumes immediately.

Changing Pi's session thinking level also pins the last served model at the new supported level.

Before any model serves, a thinking-level change affects only the next turn. Background requests do not set this pin or change Pi's session level.

## Confirmation before model changes

```text
/router-semi
/router-semi on
/router-semi off
```

Without an argument, the command shows the current setting. `on` and `off` save the setting in `config.json`.

In an interactive session, confirmation offers these choices:

- Accept the selected model.
- Keep the incumbent for the current user entry.
- Select a concrete model and create a session pin.

Dismissal or cancellation cancels the turn. Non-interactive sessions omit this confirmation.

## Model exclusions

```text
/router-blacklist
/router-blacklist add <patterns> [--save]
/router-blacklist remove <patterns> [--save]
/router-blacklist clear
```

Without an action, the command shows persistent and session exclusions.

`add` and `remove` accept one or more model patterns. Without `--save`, they affect the current session.

Use `--save` to change the persistent configuration list. The command also updates session patterns.

`clear` removes all session blacklist state. It does not change the persistent configuration list.

Examples:

```text
/router-blacklist add github-copilot/example-model
/router-blacklist add */example-model --save
/router-blacklist remove github-copilot/*
/router-blacklist clear
```

The example model is a placeholder, not a model recommendation.

To remove a usage-limit exclusion after restoring provider access, use `remove <provider>/*` without `--save`.

Removing only one model does not remove a provider-wide usage-limit exclusion. Persistent exclusions can still prevent automatic selection.

## Persistence summary

| Action | Saved across sessions? |
|---|---|
| Sync data and explicit sync key | Yes |
| Benchmark alias | Yes |
| Semi-automatic setting | Yes |
| Blacklist with `--save` | Yes |
| Manual pin | No |
| Blacklist without `--save` | No |
| Runtime model or provider exclusion | No |

[Implementation: command handlers](../extensions/host/commands.ts)
