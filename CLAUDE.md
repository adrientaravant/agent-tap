# agent-tap — rules for agents

A capture proxy between a coding agent and its model API, plus a viewer. `server.mjs` is
plain Node ESM with no dependency; keep it that way, because a dependency here sits in
the path of every API call.

## Hard rules

- **The reply path comes first.** Write bytes to the client before you parse them. Never
  buffer a stream to analyse it.
- **No credential on disk.** `redactHeaders` is the only gate. If you add a header to a
  record, check it against `REDACT` first. The test `strips credentials from the file`
  must stay.
- **Never turn TLS verification off.** If an API is unreachable, add roots.
  `NODE_TLS_REJECT_UNAUTHORIZED` must not appear in this repository.
- **Say where content comes from.** Every panel is labelled captured or computed.
- **Store raw, normalise on read.** `viewOf` and `callsOf` reshape a record when it is
  served. Never rewrite what was captured.
- **The viewer only ever deletes.** Two endpoints, both confined to `WIRETAP_DIR` by
  `safeName`. Nothing else writes.
- **`/__wire/` is the only reserved path.** Everything else is proxied unchanged.

## Layout

- `server.mjs` — proxy, record writer, viewer API. One file on purpose.
- `bin/wiretap.mjs` — the on/off switch (`agent-tap`, `wiretap`).
- `ui/` — viewer source (React, Tailwind, shadcn/ui). Build with `cd ui && npm run build`; output goes to `viewer/dist`, which is committed so the tool runs with no
  build step. CI fails if it is stale.
- `test/proxy.test.mjs` — end to end against a fake API. No network.

## Found by measurement, not by reading documentation

- **A process variable beats `settings.json`, and the Claude desktop app cannot be
  captured.** It inherits the variable, then overrides it for every session it spawns.
  Do not re-add a desktop route: it would look like it works and capture nothing.
- **Codex hides its shape.** Tools live in `input[0]` as `additional_tools`; the system
  prompt is developer messages; a custom tool call carries `input`, not `arguments`; its
  result is a *list* of blocks; the reply has no `content-type`, so a stream is detected
  from the request.
- **The local Node has an incomplete root list.** Homebrew Node 26.5.0 carries 120 roots
  and no GlobalSign, so plain `https.get` fails for any host. Do not remove the system
  roots code because "the API works in curl".
- **Markers are matched as text, not regex.** `# --- agent-tap (managed) ---` contains
  parentheses; a regex built from it matches nothing and `off` silently leaves the block
  in `~/.codex/config.toml`.

## Verify

```bash
node --test test/proxy.test.mjs
```

A UI change also needs the page loaded in a browser, with the console checked.
