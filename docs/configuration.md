# Configuration

[Overview](overview.md) · [Command reference](commands.md)

## File and format

The default file is `~/.pi/agent/pi8/config.json`. The file is optional. Absent options use their defaults.

Use valid JSON. Do not add comments or trailing commas to the file.

`PI8_DIR` changes the storage directory for configuration, benchmarks, global model history, and prompt-token scales.

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
| `preferences` | Empty profile | Per-user routing preferences for minimax regret optimization. |
| `models` | All available models | Allowlist of model patterns. An empty array adds no restriction. |
| `blacklist` | `[]` | Persistent model exclusions. |
| `prompt` | `true` | Show notifications when the selected model changes. |
| `semi` | `false` | Ask before a model change in an interactive session. |
| `switchMargin` | `0.15` | Maximum cache credit and protocol penalty. Valid range: 0 to 1. |
| `routerContextWindow` | Dynamic | Optional positive token limit for the advertised context window. |
| `debug` | Off | `true` enables the session debug log and renders dim debug entries in the Pi chat. A string selects an explicit file path. |
| `syntheticPrefixes` | `[]` | Literal prefixes for synthetic integration messages whose source is not available in Pi's session projection. Projected custom messages need no prefix. Maximum length: 200 characters per prefix. |
| `dimensionWeights` | See below | Fallback quality, cost, and speed weights for central scoring. |
| `reputation` | `true` | Collect protocol counts and enable eligible history-based preferences. |
| `reputationWeights` | Unset | Weights for `reminder` and `ignored`. Each value must be between 0 and 1. |
| `baselineModel` | Automatic | `provider/id` for the cost comparison in `/router-report`. |

The parser ignores invalid values or uses the relevant default. An invalid JSON file supplies no configuration options.

Do not depend on this recovery for configuration validation. Check your edits before use.

The configuration controls preferences, not capability minimums. Automatic main-turn selection has no capability tiers; see [Routing](routing.md#one-comparison-pool).

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

## Routing preferences

The `preferences` object specifies semantic trade-offs for minimax regret selection:

```json
{
  "preferences": {
    "version": 1,
    "settledImplementation": "lower_cost",
    "openDesignDecisions": "higher_reasoning_capability",
    "handoffWarmCache": "keep_warm_incumbent",
    "researchTasks": "higher_research_capability",
    "afterRework": "switch_model"
  }
}
```

The profile requires `version: 1`. Each core field accepts its specific options or non-decisions (`equivalent`, `unsure`, `skip`):

| Preference field | Option A | Option B |
|---|---|---|
| `settledImplementation` | `lower_cost` | `higher_coding_capability` |
| `openDesignDecisions` | `lower_cost` | `higher_reasoning_capability` |
| `handoffWarmCache` | `keep_warm_incumbent` | `switch_for_capability` |
| `researchTasks` | `lower_cost` | `higher_research_capability` |
| `afterRework` | `increase_effort` | `switch_model` |

Substantive answers add linear constraints to the weight domain $\Theta$. Minimax regret selects the candidate that minimizes maximum regret across all weight vectors in $\Theta$.

`unsure` and `skip` add no constraint.

An invalid field value or unsupported version marks the profile invalid. An invalid profile is never partly applied; the selector falls back to the base weight domain.

Use `/router-preferences` to inspect the saved profile and its binding status.

## Scoring weights

These are the fallback defaults for central scoring.

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

Sync key precedence is: command argument, environment variable, saved configuration.

## Sources

- [Configuration parser](../extensions/config.ts)
- [Default weights](../extensions/constants.ts)
- [Main-turn policy](../extensions/routing/policy/routing-policy.ts)
- [Storage resolver](../extensions/bench/store.ts)
