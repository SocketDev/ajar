# account-snapshot-recorder

SessionStart recorder. Never blocks.

## What it does

Records which signed-in account a session belongs to, into
`.cache/fleet/socket-model-cost/accounts/`. One file per session, plus a
`latest.json` pointer to the current seat.

## Why it exists

Session transcripts carry **no account field**. Verified by key-listing real
transcripts: they hold `sessionId`, `requestId`, `cwd`, and `userType`, and no
account, organization, or email anywhere.

So spend cannot be attributed to an account after the fact. The only record of
who was signed in is the one taken while they were signed in, which makes every
unrecorded day permanently unattributable. That asymmetry is the whole argument
for recording early: a guard can be added later and still works, attribution
cannot.

Attribution matters because two accounts bill differently for identical token
usage. A metered or overage-enabled seat spends real dollars per token; a
flat-quota seat spends subscription headroom. A total that mixes them is wrong
for both. Four distinct organization UUIDs already appear in this machine's local
caches, so this is a live case rather than a precaution.

## Privacy

The record stores a short **digest** of the organization UUID, never the UUID,
the email, or the organization name. Attribution survives without the identity
travelling with it, so the store stays safe to read and to hand over.

Organization-scoped rather than user-scoped because that is the granularity
billing differs at: the client caches credit grants and seat eligibility per
organization UUID.

## When it speaks

Only when the account **changed** since the last recorded session. A recorder
that narrated every session would be noise, and the change is the only part a
reader must act on.

## Failure behavior

Fails open and silent on every path: a missing config, unreadable JSON, an
unwritable cache. A recorder that breaks a session costs more than the
attribution is worth.

## Bypass

None. It never blocks, so there is nothing to release.
