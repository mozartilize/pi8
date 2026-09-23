# AGENTS.md — pi8

A Pi extension registering a synthetic `router/auto` provider: it classifies each turn, scores candidates from Pi's model registry against synced benchmark data, and delegates the stream with a fallback chain. It stays in-process — no external gateway or daemon — and takes benchmark data from APIs rather than scraping. User-facing behavior is in `README.md`.

## What belongs here

Rules are **traps to avoid**, not **maps to follow**. No module layout, data flow, or key-type descriptions — they go stale fast and the agent can gather them by reading the code.

## Hard rules (do not violate)

1. **Router bugs must not block a turn.** Catch errors at new hooks, commands, and the provider boundary; degrade to defaults or a router error event.
2. **Uncertainty never makes routing cheaper.** A missing, failed, or low-confidence assessment keeps at least the heuristic task type; unknown quality outranks measured weak quality. Only a high-confidence bounded assessment can lower the task type, subject to the caps in `adoptAssessment`. Effort minimums are not assignments; a scored effort may raise but never lower them. An investigation-phase discount is bounded, and economic promotion requires measured quality.
3. **Do not leak a failed attempt's events into the consumer stream.** Pi treats its first terminal `done` as the end of the turn; an answerless attempt must be discarded so fallback can answer. Lifecycle-only events do not stop the meaningful-output timeout. Never replay after visible text, a tool call, or a thinking-overflow commit.

## Assessment egress and privacy

With `consultRouter: true`, one bounded, cancellable assessment runs per user entry; `false` sends none. The assessor may use a different provider from the serving model. Its prompt contains only role-labelled recent conversation, the latest compaction or branch summary (labelled, if present), tool and skill **names** (plus tool counts), and the five task-type definitions. Never send tool arguments or results, file contents, environment values, or skill descriptions. Scrub credentials and truncate oldest-first to `assessmentMaxInputChars`, preserving the latest request. Record assessment outcomes and spend separately from routed spend; `/router-status` shows the cost.

## Terminology for reviews and user-facing text

Name the specific minimum instead of saying “floor.” Do not confuse task types, capability tiers, and capability bands, or a task's final step with a stream-ending event. Keep internal identifiers stable; use plain language in user-facing text. Definitions are in [`ARCHITECTURE.md`](ARCHITECTURE.md#terms-and-minimums).

## Comment style

Comments should explain *why the current code is the way it is*, not narrate its history. This binds test comments exactly as it binds source comments: describe the invariant being pinned, never that it replaced an older one. Write:

> "Benchmarks only cover quality indices — price/speed/context ship in Pi's own registry metadata."

not:

> "We used to fetch price from benchmarks too, but then we discovered the registry already had it…"

A reader with no access to the previous revision must not be able to tell which lines are new. Words like *used to*, *no longer*, *previously*, *now*, and *behavior change* are the tell — if removing the historical clause loses no information about the current code, it was never information.

If a past mistake or regression is worth preserving for future readers, it belongs in a commit message, not narrated inline in source comments.

## Testing conventions

- `npm run tsc` and `npx vitest run` must both pass before considering any change done. Inspect the test/file counts reported by the current run rather than relying on a hard-coded historical count.
- **Always run vitest under an explicit timeout** (e.g. `timeout 60 npx vitest run …`). A hanging test — not a slow one — is a failure mode: vitest buffers per-file output, so a blocked test prints nothing until it dies. When a run hangs, bisect with `-t` filters and `--test-timeout` rather than assuming slowness.
- **Never use `/proc/…` (or similar virtual-fs paths) as an unwritable path in tests.** Filesystem calls under `/proc` can block indefinitely on some kernels — even a plain `existsSync`/`mkdirSync`. For a fast, portable unwritable path use a regular file in place of a directory (ENOTDIR, fails in 0 ms), e.g. `<tmp>/blocker.txt/sub`.
- Adapters are tested against fixture payloads (`extensions/__fixtures__/`); benchmark re-syncs may legitimately require fixture review.
- **Tests pin contracts, not snapshots.** A failing test must be classifiable: a contract violation (fix the code) or an expected behavior change (rewrite the test in the same change). Never update a pinned value to green without that classification. State the classification in the commit message — a test comment states the invariant the test pins *now*, never that the behavior changed or what it used to be. Contract tests pin invariants (up-only uncertainty, `plan` never promoted, tiers stay in the fallback chain, escalation excludes the requesting model) and must never break; snapshot/behavior tests pin current values (winners, scores, reason strings) and are rewritten together with the redesign they encode. Benchmark fixtures only — never pin live store data.
- Test seams exist deliberately — `setDelegationTimeouts()` (delegation.ts), `PI8_DIR` (store.ts/config.ts), and the debug/decision-log path setters. Use them; don't monkeypatch around them. A seam is not a licence to export production symbols that only tests call.
