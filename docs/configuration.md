# Configuration

[Overview](overview.md) · [Command reference](commands.md)

## File and format

The default file is `~/.pi/agent/pi8/config.json`. The file is optional. Absent options use their defaults.

Use valid JSON. Do not add comments or trailing commas to the file.

`PI8_DIR` changes the storage directory for configuration, benchmarks, and global model history.

## Minimal configuration

```json
{
  "models": ["github-copilot/*"],
  "blacklist": [],
  "prompt": true,
  "semi": false
}
```

This example limits automatic routing to available GitHub Copilot models. It does not authenticate the provider.

## Reference

| Option | Default | Meaning |
|---|---|---|
| `artificialAnalysisApiKey` | Unset | Key for benchmark sync. `/router-sync <key>` saves it. |
| `models` | All available models | Allowlist of model patterns. An empty array adds no restriction. |
| `blacklist` | `[]` | Persistent model exclusions. |
| `prompt` | `true` | Show notifications when the selected model changes. |
| `semi` | `false` | Ask before a model change in an interactive session. |
| `switchMargin` | `0.15` | Maximum cache credit and protocol penalty. Valid range: 0 to 1. |
| `routerContextWindow` | Dynamic | Optional positive token limit for the advertised context window. |
| `debug` | Off | `true` uses the session debug log. A string selects a file path. |
| `syntheticPrefixes` | `[]` | Literal prefixes for synthetic integration messages. Maximum length: 200 characters per prefix. |
| `dimensionWeights` | See below | Legacy main-turn and subagent quality, cost, and speed weights. |
| `reputation` | `true` | Collect protocol counts and enable eligible history-based preferences. |
| `reputationWeights` | Unset | Weights for `reminder` and `ignored`. Each value must be between 0 and 1. |
| `baselineModel` | Automatic | `provider/id` for the cost comparison in `/router-report`. |

The parser ignores invalid values or uses the relevant default. An invalid JSON file supplies no configuration options.

Do not depend on this recovery for configuration validation. Check your edits before use.

The configuration controls preferences, not capability minimums. Changing weights cannot move a measured weak candidate into the preferred capability tier.

## Model patterns

Patterns match `provider/id`. Matching is case-insensitive. An asterisk matches arbitrary characters. A provider name without a slash means `provider/*`.

Examples:

```json
{
  "models": ["github-copilot", "openai-codex/*"],
  "blacklist": ["*/gemini*", "github-copilot/example-model"]
}
```

These identifiers illustrate the syntax. Use `/router-models` to check your installed registry.

The command shows allowlist matches. Runtime failures and provider exclusions can reduce the candidates further.

A [manual pin](commands.md#manual-model-control) is an explicit override. It can select an authenticated model outside the automatic allowlist or blacklist.

## Default scoring weights

These are the `legacy` defaults. Subagent role selection also uses them unless `dimensionWeights` supplies overrides.

| Task type | Quality | Cost | Speed |
|---|---:|---:|---:|
| `lightweight` | 0.20 | 0.60 | 0.20 |
| `gather` | 0.40 | 0.40 | 0.20 |
| `plan` | 0.80 | 0.15 | 0.05 |
| `implement` | 0.60 | 0.30 | 0.10 |
| `review` | 0.70 | 0.25 | 0.05 |

An override can specify one task type:

```json
{
  "dimensionWeights": {
    "implement": { "quality": 0.6, "cost": 0.3, "speed": 0.1 }
  }
}
```

Weights must be finite and nonnegative. Missing fields retain the default for that task type.

### Cheapest-sufficient weights

Automatic main-turn selection under `cheapest-sufficient` uses fixed weights for every task type:

| Quality | Cost | Speed |
|---:|---:|---:|
| 0 | 1 | 0 |

`dimensionWeights` does not change these main-turn weights.

Quality still determines capability tiers. Context and vision minimums still apply. Cache credit and configured protocol penalties can still change preference within a tier.

Subagent role selection retains `legacy` scoring and configured `dimensionWeights`, even when main turns use `cheapest-sufficient`.

## Context window

Before a model serves, `router/auto` advertises the largest routable context window. After a model serves, it advertises that model's window.

`routerContextWindow` can reduce this value. It cannot increase the advertised window beyond the dynamic default.

A smaller limit makes Pi compact earlier. It can preserve eligibility for models with smaller context windows.

The value does not increase a destination model's capacity.

## Protocol history

`reputation: true` collects history by default. Unset `reputationWeights` means no compliance penalty.

Fit weights from at least two weeks of observations. Do not treat fixture results as calibrated weights.

Setting `reputation: false` disables collection, cross-session cache credit, and protocol penalties. Same-session cache preference is separate.

Setting `switchMargin: 0` disables cache credit and protocol penalties.

## Environment variables

| Variable | Purpose |
|---|---|
| `PI8_DIR` | Override the pi8 storage directory. |
| `ARTIFICIAL_ANALYSIS_API_KEY` | Supply the key for benchmark sync without saving a command argument. |
| `PI8_POLICY_VERSION` | Select `cheapest-sufficient` for evaluation. Absent or unknown values select `legacy`. |

Sync key precedence is: command argument, environment variable, saved configuration.

`PI8_POLICY_VERSION` is not a user configuration option. See [Routing](routing.md#evaluation-comparator) before using it.

## Sources

- [Configuration parser](../extensions/config.ts)
- [Default weights](../extensions/constants.ts)
- [Main-turn policy](../extensions/routing/policy/routing-policy.ts)
- [Subagent role selection](../extensions/agents/subagents.ts)
- [Storage resolver](../extensions/bench/store.ts)
