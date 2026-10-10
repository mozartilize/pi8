# AGENTS.md — pi8

These instructions apply only to AI coding agents. This file is not a contributor guide.

A Pi extension registering a synthetic `router/auto` provider: it resolves each turn's task type from router state and the model's accepted declarations, scores candidates from Pi's model registry against synced benchmark data, and delegates the stream with a fallback chain. It stays in-process — no external gateway or daemon — and takes benchmark data from the Artificial Analysis API and its public models page, read with Playwright. User-facing behavior is in `README.md`.

## What belongs here

Rules are **traps to avoid**, not **maps to follow**. No module layout, data flow, or key-type descriptions — they go stale fast and the agent can gather them by reading the code.

## Hard rules (do not violate)

1. **Router bugs must not block a turn.** Catch errors at new hooks, commands, and the provider boundary; degrade to defaults or a router error event.
2. **Uncertainty must not lower capability minimums.** Unknown quality ranks above measured weak quality. Change task types only through accepted declarations. Preserve incumbent capability and thinking minimums except at defined routing boundaries. Price, cache credit, and protocol penalties apply only within capability tiers. See [Routing](docs/routing.md) for detailed rules.
3. **Do not leak a failed attempt's events into the consumer stream.** Pi treats its first terminal `done` as the end of the turn; an answerless attempt must be discarded so fallback can answer. Delegation sets no auth or output deadline. Lifecycle-only events do not count as meaningful output. Never replay after visible text, a tool call, or a thinking-overflow commit.

## Decision-log privacy

The router makes no separate model calls. Every model call serves the user's turn. Decision-log records carry ids, codes, categories, and counts — never findings, questions, file paths, tool arguments, or model-written text.

## Terminology for reviews and user-facing text

Name the specific minimum instead of saying “floor.” Do not confuse task types, capability tiers, and capability bands, or a task's final step with a stream-ending event. Keep internal identifiers stable; use plain language in user-facing text. Definitions are in the [Glossary](docs/glossary.md).

## Wording (ASD-STE100)

Identifiers, log values, comments, tool descriptions, router notes, and docs follow the controlled-language rules of ASD-STE100 (Simplified Technical English):

- Give each concept one name, and use that name in code, logs, and docs. Do not add a synonym for a concept that already has a name.
- Use the most common word that has the correct meaning.
- Do not use metaphors or idioms. Name the action that the code does.
- Use a single-word verb instead of a phrasal verb when both have the same meaning.
- In text that a model reads (tool descriptions, router notes, reminders), write short sentences in the active voice, with one instruction in each sentence.

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
- Adapters are tested against fixture payloads (`fixtures/`); benchmark re-syncs may legitimately require fixture review.
- Read a rule that Pi owns from Pi (for example `getSupportedThinkingLevels`). Do not copy it into the router. A test that mocks `@earendil-works/pi-ai` spreads the real module and overrides only what the test controls.
- `fixtures/real-pool.json` is a frozen copy of real benchmark rows and pi-ai catalog entries. Tests on it pin properties that hold for any realistic pool, never which model wins. Regenerate both halves together. A hand-written fixture repeats the author's assumptions about provider behavior; check each assumption against the provider code or the real data.
- A test for a fix must fail on the code before the fix. Revert the fix or change the guarded line, and run the test once to see it fail.
- **Tests pin contracts, not snapshots.** A failing test must be classifiable: a contract violation (fix the code) or an expected behavior change (rewrite the test in the same change). Never update a pinned value to green without that classification. State the classification in the commit message — a test comment states the invariant the test pins *now*, never that the behavior changed or what it used to be. Contract tests pin invariants (up-only uncertainty, price never offsets a missed minimum, tiers stay in the fallback chain, escalation excludes the requesting model) and must never break; snapshot/behavior tests pin current values (winners, scores, reason strings) and are rewritten together with the redesign they encode. Benchmark fixtures only — never pin live store data.
- Test seams exist deliberately — `setDelegationTimeouts()` (delegation.ts), `PI8_DIR` (store.ts/config.ts), and the debug/decision-log path setters. Use them; don't monkeypatch around them. A seam is not a licence to export production symbols that only tests call.
