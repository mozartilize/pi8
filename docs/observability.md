# Observability

[Overview](overview.md) · [Command reference](commands.md)

## Interactive diagnosis

Start with these commands:

```text
/router-status
/router-why
/router-report
```

`/router-status` shows data readiness and session state. `/router-why` explains selection and execution-plan retention.

Use `/router-report` for registry-priced cost estimates, not billed cost.

## Log files

| Log | Default location | Purpose |
|---|---|---|
| Decision log | Beside Pi's saved session transcript | Selection, fallback, work lifecycle, contracts, and attempt usage |
| Global model history | `~/.pi/agent/pi8/model-events.jsonl` | Protocol counts and exact-prefix cache history |
| Debug log | Beside Pi's saved session transcript when enabled | Timing and diagnostic events |

A decision sidecar uses `<timestamp>_<sessionId>.router-decisions.jsonl`.

Without a saved transcript, decision records use the shared `~/.pi/agent/pi8/decisions.jsonl` file.

A debug sidecar ends in `.router-debug.log`. Without a saved transcript, debug output uses `/tmp/pi8-debug.log`.

`PI8_DIR` changes the global storage directory. A configured debug path overrides the default debug location.

## Enable debug output

1. Add this option to `config.json`:

   ```json
   {
     "debug": true
   }
   ```

2. Start a new Pi session to apply the session debug setting.
3. Reproduce the problem.
4. Inspect the debug sidecar for that session.

A string selects an explicit path:

```json
{
  "debug": "/path/to/private/pi8-debug.log"
}
```

Do not write a debug log into a public checkout when the request contains sensitive material.

## Decision records

Decision records include task type, selected candidate, cause, fallback order, and capability diagnostics.

Handoff and contract records add rubric levels, measured counts, requirement, outcome, rejection codes, and model keys.

`/router-why` shows contract details on its `plan:` line. Excluded executors appear on `excluded:`.

An `editing` marker reports an observed mutation. It does not change the task type.

Readers retain support for cause values in older records. A legacy cause does not imply that its selection path remains active.

The evaluation comparator records:

- Capability-policy digest and comparison axis.
- Reference metric version and reported index version when available.
- Complete required vector, including context and vision minimums.
- Digest of the normalized benchmark store.

The policy digest covers fixed vectors, references, requirement mapping, comparison axis, component rules, and input-shape rules.

These fields identify policy and data inputs. They do not prove task sufficiency.

## Protocol history

Global history uses two identities:

| Identity | Purpose |
|---|---|
| Model release, without provider or effort | Protocol counts |
| Exact provider, model, and effort | Cache estimates |

Protocol identity normalizes `.`, `_`, and `-` separators. It retains date and revision suffixes so releases do not inherit another release's counts.

Served and reminder records retain task type. Reminder kinds are `context`, `completion`, and `contract`.

Each kind has a separate rate. The router does not combine the kinds into one rate.

The session reads history once per user entry, not on every continuation. Folding ignores malformed records, obsolete rule versions, and records older than 90 days.

The router deduplicates entries and reminder episodes. A reminder outcome belongs to the model that received it.

A replacement model or interrupted continuation does not count as an ignored reminder.

Counts decay with a 30-day half-life. Eligibility thresholds and weighted penalties appear in [Scoring](scoring.md#protocol-preference).

Sync does not rewrite the append-only history file. Rewriting could lose concurrent appends from another session.

History read/write failures do not block turns. Execution outcomes do not receive positive preference rewards.

`/router-status` shows decayed counts and penalties. `/router-why` shows a penalty that changed the preferred candidate.

## Attempt timing

Each provider attempt can record these fields in its `attempt-usage` event:

| Field | Meaning |
|---|---|
| `authMs` | Elapsed time when authentication completes |
| `firstEventMs` | Elapsed time at the first stream event |
| `firstOutputMs` | Elapsed time at the first text or tool event |
| `durationMs` | Total elapsed attempt time |
| `maxEventGapMs` | Longest silence after authentication, including the initial and final waits |

All elapsed milestones start at attempt start. They include authentication time.

A missing milestone means that the attempt did not reach it. It does not mean zero milliseconds.

Lifecycle and thinking events can establish `firstEventMs` without establishing `firstOutputMs`.

`outputState` contains these flags:

- `visibleTextReceived`.
- `toolCallReceived`.
- `committedToStream`.

These flags explain why replay can be unsafe after an error. A thinking-buffer commit can prevent replay without visible text or a tool call.

The debug log also records attempt timing, including attempts that fail during authentication.

Step timing covers registry waits, scoring, candidate authentication/stream attempts, and total turn duration.

## Cost report

The report prices observed tokens at registry rates. It also prices those tokens at a baseline model's rates.

With no `baselineModel`, the router selects the strongest measured routable candidate on the production task axis.

A configured baseline applies when it remains in the routable pool. The report still uses production capability comparisons during comparator evaluation.

The baseline is counterfactual. It does not measure what the baseline model would actually generate.

Interpret the report with these limits:

- Missing usage makes routed spend a lower bound.
- Missing prices omit a turn from priced totals.
- Foreground child usage can contribute to the totals.
- Async child costs are absent.
- Provider subscription charges may differ from registry token prices.
- A changed baseline can make session totals harder to compare.

A reported saving does not establish equal task quality.

## Privacy and security

Decision records contain identifiers, codes, categories, measurements, and counts. They do not store findings, questions, plan paths, tool arguments, or model-written text.

Global model history uses opaque entry and prompt hashes. It does not store requests or replies.

These restrictions do not apply to Pi's transcript. The transcript can contain prompts, source content, tool arguments, and credentials entered as text.

Debug diagnostics can include provider error text. Treat debug files as sensitive and inspect them before sharing.

The saved configuration can contain the Artificial Analysis API key. Command-based writes request restrictive file permissions, but permission behavior depends on the operating system.

Before publishing logs:

1. Remove API keys and provider credentials.
2. Inspect provider errors for sensitive text.
3. Remove private model identifiers if necessary.
4. Exclude the Pi transcript unless you intend to share its contents.

No external model gateway is necessary. Requests still reach the selected model provider, and benchmark sync contacts Artificial Analysis.

## Report a problem

Include the project revision, Pi version, active policy, relevant commands, and sanitized diagnostics.

For selection problems, include benchmark version and coverage. For stalled attempts, include timing milestones and cancellation behavior.

Do not publish `config.json` or a raw transcript without inspection.

[Decision log implementation](../extensions/host/decisionlog.ts) · [Debug log implementation](../extensions/host/debuglog.ts)
