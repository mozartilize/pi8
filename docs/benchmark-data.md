# Benchmark data

[Overview](overview.md) · [Routing](routing.md)

## Sources

Artificial Analysis supplies two parts of the same benchmark source:

- The Data API supplies indexes, pricing, and performance measurements.
- The public models page supplies additional capability measurements and task-level data.

The router reads the models page through headless Chromium with `playwright-core`.

Pi's model registry supplies provider identities, authentication access, supported modes, context windows, and provider-specific token prices.

The router combines these sources. It does not use a separate model to interpret them.

The API uses the `x-api-key` header. The page reader captures the decrypted models payload from headless Chromium.

Public-page measurements join API rows by benchmark slug and parsed effort. The joined row carries quality, pricing, and performance measurements.

Performance includes output tokens per second and first-token/first-answer latency. Page data also identifies estimated indexes.

## Refresh behavior

Run `/router-sync` to refresh benchmarks. The data becomes stale after 14 days, which produces a warning.

Sync is not a scheduled background service. Stale data remains available until a successful refresh replaces it.

The API and models page must both succeed. A source fetch failure preserves the previous store.

When sync matches no registry models, it preserves an existing store with active rows.

If no usable store exists, automatic routing returns a setup error before delegation. A manual pin and a concrete-model session remain available.

A missing browser prevents refresh, not routing with an existing usable store.

## Saved files

| File | Contents |
|---|---|
| `benchmarks.json` | Normalized rows, sync time, index version, and aliases |
| `config.json` | Sync key and router options |
| `model-events.jsonl` | Global protocol history, separate from benchmark data |

These files use `~/.pi/agent/pi8/` by default. `PI8_DIR` changes the directory.

The benchmark store uses version 2. A version 1 store cannot preserve effort identity and requires a fresh sync.

Do not replace a live store with test fixtures. Tests must use isolated storage.

## Model matching

Benchmark slugs do not always equal registry identifiers. The matcher resolves slugs against Pi's registry and saved aliases.

An unmatched model has no matched benchmark quality. Registry pricing does not supply evidence of capability.

Effort labels come from parenthetical model-name segments. The first recognized comma-separated segment wins, including a label followed by fallback or provenance text.

A non-reasoning label maps to `off`. An unrecognized label remains undefined.

An explicit variant list normalizes known benchmark rerun suffixes such as `-1234`.

The matcher does not strip arbitrary numeric suffixes. Those suffixes can identify real model releases.

To correct a mapping:

1. Inspect unresolved rows with `/router-status`.
2. Check the registry model's identity.
3. Run `/router-fix <slug> <provider/id>`.
4. Run `/router-sync` again.

Do not map different model releases merely because their names look similar.

## Effort identity

A benchmark row represents `(registryId, effort)`. Measurements from `low` and `high` are separate rows.

Storage joins the identity components with a NUL separator. Candidate keys use a colon for the effort.

Candidate keys use `provider/id:effort`. An absent effort label remains distinct from a named level.

When several rows resolve to the same identity, the router retains one whole row. It prefers measured quality, then greater axis coverage.

It does not combine quality axes from different runs into one synthetic measurement.

Supported lower efforts can receive conservative estimates from higher measured efforts. Estimates do not supply task cost, speed, or latency measurements.

Estimated quality can satisfy ordinary eligibility checks. It cannot prove cross-model strength for escalation or excluded-executor replacement.

## Measurement meanings

| Project field | Measurement |
|---|---|
| `intelligence` | Artificial Analysis Intelligence Index |
| `agenticCoding` | Terminal-Bench 4.0 pass rate in percent |
| `agenticIndex` | Artificial Analysis Agentic Index |
| `knowledge` | Omniscience index |
| `research` | Briefcase rubric pass rate |
| `longContext` | LCR correctness |
| `visionReasoning` | MMMU-Pro correctness |
| `costPerTask` | Benchmark task cost at the measured effort |
| `timePerTaskSeconds` | Benchmark task duration at the measured effort |

Indexes measure different tasks. Equal numbers on different indexes do not imply equal capability.

## Calibration warnings

The capability minimums use Intelligence Index version 4.3.

A missing or different major/minor version produces a warning. Sync still saves the data, and routing continues with the calibrated minimums.

A change greater than 15% in the strongest Intelligence score also produces a warning.

Version warnings appear at sync, automatic-model selection, and `/router-status`. They do not depend on the current candidate pool.

Do not infer that a successful sync proves the minimums are sufficient. Review benchmark scale changes before recalibrating policy.

## Agentic-coding estimates

Each sync fits older Artificial Analysis indexes to measured Terminal-Bench 4.0 results using least squares.

The fit uses agentic, coding, and Intelligence indexes where available. Rows without coding or Intelligence use an agentic-only fit.

The estimate subtracts the fit's leave-one-out error from its prediction.

A row without the agentic index stays unknown. Coding alone does not produce an agentic-coding estimate.

Estimated rows carry `qualityEstimated`. They cannot prove cross-model escalation strength.

This estimate is distinct from downward effort estimation. See [Scoring](scoring.md#downward-effort-estimates).

## Evaluation limits

Benchmark cost is not the price of your actual task. Prompt length, cache use, provider behavior, and model trajectories can change observed spend.

Compare evaluation runs only when their prompts, fixtures, environment, policy, and accounting rules match.

A fixture or environment digest alone does not establish equivalent prompts.

[Adapters](../extensions/adapters/artificial-analysis.ts) · [Store](../extensions/bench/store.ts) · [Sync](../extensions/bench/sync.ts)
