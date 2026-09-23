# Auto session title is an opt-in, first-message, background convenience

Users had to press the title-bar button to get a meaningful session name; sessions
otherwise show the first 50 characters of their first message.

Pi Web therefore offers an experimental **Auto session title** setting. When it is
enabled, a session is named automatically after its first prompt settles. The
setting lives in `~/.pi/agent/session-title.json`:

```json
{
  "version": 1,
  "autoEnabled": true,
  "model": { "provider": "anthropic", "modelId": "claude-haiku-4-5" }
}
```

## The session, not the browser, decides eligibility

The browser hook only knows that a prompt finished: `AppShell` posts
`{ trigger: "auto" }` to `POST /api/sessions/[id]/auto-name` at most once per
session, after `onAgentEnd`. It sends no session state, because a client-derived
"first message" is optimistic (it can be rolled back by a failed send, double
counted by merged stats, or re-derived from the file after a reload).

This also bounds the trigger to the chat that is open: switching away from a
session before its first reply finishes skips background naming for it, and the
title-bar button stays available. Naming a session nobody is watching would
require hooking `prompt_done` inside `lib/rpc-manager.ts` instead.

The route is the authority. It skips, with `200 { skipped }`, when the feature is
off, when the session already has a name (a `/name` command or rename must never
be overwritten), when there is no user message, or when the session has more than
one user message — which is exactly "the just-finished prompt was the first one".
The settings are read *before* the session is resolved, so a disabled feature
cannot even start an `AgentSession`.

## Failure is never user-visible

Background naming is best effort:

- An unreadable settings file means "disabled", not an error.
- The client ignores non-2xx responses and empty titles, and never writes to the
  `AutoNameStatus` banner, the chat, or the notification path.
- The manual button keeps its own visible success/error feedback and marks the
  session so the background trigger will not fire again.

Only the resolved title is persisted — a `session_info` entry written by
`setSessionName`. The title request itself is a standalone uncached stream over a
bounded plain-text transcript (`buildTitleTranscript`), so a naming run can
neither mutate the project, appear in the session file, nor grow with the
session.

## Model

The configured model is resolved through the live session's `ModelRuntime` at use
time, then clamped to its cheapest thinking level: a title is a short extraction
task. The transcript request does not reuse the session's cache prefix, so
choosing another model costs no cache; `null` (the default) means "follow the
session".

Resolution is deliberately best effort. An id that no longer exists, or a
provider whose credentials were removed, falls back to the session's own model
and reports `modelFallback` in the response. Failing instead would break the
pre-existing manual button for every session as soon as one title model goes
away — a new setting must not be able to regress existing functionality.

The setting applies to manual generation too, so "the title model" has one
meaning. The manual path stays available for sessions that were already named or
already have several messages.
