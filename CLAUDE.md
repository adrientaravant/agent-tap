# agent-tap — rules for agents

A capture proxy between Claude Code and the Anthropic API, plus a viewer. Plain Node
ESM, no dependency, no build step. Keep it that way: a dependency here is a dependency
in the path of every API call.

## Hard rules

- **The reply path comes first.** Write bytes to the client before you parse them.
  Never buffer a stream to analyse it. A slow proxy makes the client look broken.
- **No credential on disk.** `redactHeaders` in `server.mjs` is the only gate. If you
  add a header to the record, check it against `REDACT` first. The test
  `strips credentials from the file` must stay.
- **Say where content comes from.** Every panel is labelled captured or computed. A
  reader must never mistake an interpretation for the payload.
- **The viewer is read-only.** It serves files from `WIRETAP_DIR` and nothing else.
  Validate every path with `safeName` before it touches the filesystem.
- **`/__wire/` is the only reserved path.** Everything else is proxied unchanged, so
  do not add routes outside that prefix.

- **Never turn TLS verification off.** If the API is unreachable, add roots to
  the list. `NODE_TLS_REJECT_UNAUTHORIZED` must not appear in this repository.

## Layout

- `server.mjs` — proxy, record writer, and viewer API. One file on purpose.
- `bin/wiretap.mjs` — the on/off switch, exposed as the `wiretap` command.
- `ui/` — the viewer source: React, Tailwind, shadcn/ui. Build it with
  `cd ui && npm run build`; the output goes to `viewer/dist`, which the server serves.
  Follow the shadcn rules: semantic tokens, `gap-*` over `space-*`, components before
  custom markup.
- `viewer/dist/` — build output. Committed so the server runs without a build step.
- `test/proxy.test.mjs` — end to end against a fake upstream. No network.

## Two facts found by measurement, not by reading documentation

- **A process variable beats `settings.json`**, and **the desktop app cannot be
  captured**. The app inherits the GUI variable, then overrides
  `ANTHROPIC_BASE_URL` with the official host for every session it spawns —
  compared with `ps eww` on both processes. Do not re-add a desktop route to
  `wiretap`; it would look like it works and capture nothing.
- **The local Node has an incomplete root list.** Homebrew Node 26.5.0 carries
  120 roots and no GlobalSign, so plain `https.get` fails for any host. The
  server adds the macOS system roots at start. Do not remove that code because
  "the API works in curl".

## Verify

```bash
node --test test/proxy.test.mjs
```

A UI change also needs the page loaded in a browser, with the console checked.
