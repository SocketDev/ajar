# spend-warning-nudge

Stop hook that warns **once per 5% crossing** of the monthly target budget, so a session eating the budget says so while it is still running instead of at the end of the month. Non-blocking: it exits 0 on every path, including every error path.

## What it does

1. Fires at turn end and reads the current session's transcript, named by `transcript_path` in the hook payload.
2. Reads **only the bytes appended since its last run**. A byte offset, the running spend total, the carried dedup keys, and the last bucket already announced live in `<repo root>/.cache/fleet/socket-model-cost/spend/<sessionId>.json`.
3. Costs the new usage against `scripts/fleet/constants/model-pricing.json`, then computes which `warnEveryPct` bucket the session's total sits in, measured against the budget's **target** tier monthly value.
4. Speaks only when that bucket **increased** since the stored one, then records the new bucket.

## What it prints

The gauge from `renderSpendMeter`, the percentage just crossed, the percentage the next warning lands at, and the tier name. **Percentages and tier names only** - no dollar figure, unless the budget's `privacy.printAbsoluteFigures` is true. Hook output lands in the session transcript, which is exactly the corpus the spend scanner reads, so a nudge that printed the bar would write the budget into thousands of files.

When a model observed in the delta has no price entry, the line says how many and names them, and calls the reading a floor. An unpriced model is never treated as free.

## Why an offset rather than a re-read

A transcript is append-only and reaches hundreds of megabytes. Re-reading one every turn is the cost this hook exists to avoid, so each run parses only the delta.

Three cases the offset alone would get wrong, all handled:

| case | behavior |
|---|---|
| the last line has no newline yet | the partial line waits for the next run, and the offset advances only past complete lines |
| the file shrank, so it was replaced | the read restarts at 0 rather than resuming mid-line |
| the backlog is larger than `MAX_DELTA_BYTES` | the delta is capped and the rest is read on following turns |

Dedup keys carry across runs for the same reason correctness needs them at all: a compaction copy or a resumed sidechain can append a record that was already counted, and a fresh key set per run would count it twice.

## What it reuses

All of the measurement lives in `scripts/fleet/_shared/claude-usage.mts`: `scanTranscript` parses records, `costScan` prices them speed-aware, `budgetBucket` computes the crossing, `readBudgetConfig` resolves the machine-local budget, and `renderSpendMeter` draws the gauge. The delta bytes are staged to a scratch file so that canonical parser reads them, because the record shape is subtle in three ways: the `message.id + requestId` dedup key, the 1-hour cache-write split, and the `usage.speed` bucket. A second parser here would drift from the one the whole-corpus report uses.

## When it stays silent

- A malformed budget, an unreadable ledger, a missing transcript, or any throw. A spend measurement must never break a session.
- No machine-local budget file is configured. There is no bar, and inventing one would report a crossing of a ceiling nobody agreed to.
- The bucket did not increase since the last run.

## Bypass

None: the hook cannot block, so there is nothing to authorize. A machine with no budget file never hears from it.

## Test

```sh
pnpm test test/repo/unit/hooks/spend-warning-nudge.test.mts
```
