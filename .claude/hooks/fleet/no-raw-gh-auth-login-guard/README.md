# no-raw-gh-auth-login-guard

PreToolUse hook on Bash commands. Blocks a raw `gh auth login` and
prescribes the fleet wrapper `pnpm run gh:auth login` instead.

The canonical login is one exact argv - keyring web flow, ssh git
protocol, and the named-need scope set (`GH_LOGIN_SCOPES`:
`read:packages` + `workflow`). A hand-typed variant silently drops
whichever piece the operator forgot, and both failure shapes have
happened: a scope-less login 403'd the next ghcr digest read, and a
login that resolved to file storage parked the token in
`~/.config/gh/hosts.yml` - the exact path the May 2026 Nx Console
malware exfiltrated and the state `gh-token-hygiene-guard` then
hard-blocks.

Scope: `gh auth login` only. Every other `gh auth` verb (`status`,
`logout`, `refresh`, `token`) passes through - the wrapper forwards
them verbatim, so the raw and wrapped forms cannot drift. The
wrapper's own child spawn is a node subprocess, not a Bash tool call,
so the guard never blocks the wrapper itself.

Bypass: the user types `Allow raw-gh-auth bypass` verbatim in a
recent turn.
