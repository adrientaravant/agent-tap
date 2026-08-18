# agent-tap

See what your coding agent actually sends to the model.

**Claude Code** and **Codex** write their conversation to `~/.claude/projects/**/*.jsonl`
and `~/.codex/sessions/*.jsonl` — but not the wire payload. The system prompt, the tool
schemas, the cache breakpoints and the real token counts never reach those files.
`agent-tap` is a small local proxy that sits between the client and the API: it copies
each request body to a file, forwards the call unchanged, and streams the reply straight
back. A viewer reads the result.

Everything stays on your machine. No dependency, no build step, no hosting.

> **Records hold whole sessions.** A record is the entire request: system prompt, tool
> schemas, every message, and the reply — file contents and command output included.
> Credentials in headers are replaced with `[redacted N chars]` before writing, and a
> test enforces it, but the body is kept verbatim. Treat `~/.local/share/agent-tap/` as
> private.

## Start

```bash
npx agent-tap on
```

Start a session in a terminal — `claude` or `codex` — then open the viewer:

```bash
npx agent-tap open
```

```bash
npx agent-tap off
```

Needs Node 20+. From a clone: `npm link`, then use `agent-tap` (or the shorter
`wiretap`) directly.

| Command | Does |
| --- | --- |
| `on` | start the proxy, route new sessions to it |
| `off` | stop it, restore direct calls |
| `status` | proxy, both routes, capture count |
| `clear` | delete every record, so the next session is alone |
| `open` / `tail` | the viewer / the proxy log |

## What you get

- **Sessions**, split by client, newest first.
- **Calls** — one prompt makes several API calls, and only one is your conversation.
  The others are background jobs (naming the session, deciding whether the agent is
  still working). Each is labelled with what it is and why.
- **System, Tools, Messages** — the payload, with a filterable outline beside it. A
  session can send 200+ tool schemas, so the outline is the only sane way in.
- **Tool calls** — every tool the agent ran, paired with the result it got back.
- **Diff** — this call against the previous call *of the same kind*, which is what shows
  you exactly what a turn added and where the cache breakpoints moved.

Panels are labelled **on the wire** (the captured payload) or **computed** (built by
agent-tap), so an interpretation is never mistaken for the payload. Terms like *cache
write* have a hover explanation.

## What `on` changes

| Client | Written | Undone by |
| --- | --- | --- |
| Claude Code | `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` | `off` |
| Codex | a `model_providers` block in `~/.codex/config.toml`, between two markers | `off` |

Both files are backed up to `.bak` first, and an on/off cycle leaves them
byte-identical. Only sessions started **after** the switch are captured.

**After a reboot**, run `on` before you work. The proxy dies with the machine but the
routing lives in files, and that pair is the one bad state: sessions try to reach a
proxy that is not there. `status` warns when it happens; `on` or `off` both fix it.

For one session only, with no global change:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 claude
```

## Limits

- **The Claude desktop app cannot be captured.** It inherits the variable, then
  overrides it with the official host for every session it spawns (compared with
  `ps eww` on both processes). Terminal sessions only.
- **Codex looks nothing like Claude Code on the wire.** With a ChatGPT sign-in it sends
  no tool definitions in `tools` (they ride inside `input[0]`), no `instructions` (the
  system prompt is developer messages), no cache markers, and no `content-type` on the
  reply. Records are normalised when read, never rewritten — the Raw tab always shows
  what crossed the wire.
- A tool call appears once the **next** request carries its result, so the last call of
  a turn shows no result yet.

## Storage

One NDJSON file per session, one line per call, in `~/.local/share/agent-tap/`. Delete a
file, use the trash icon in the viewer, or run `agent-tap clear`. Nothing rotates
automatically and a working session is tens of megabytes, so keep an eye on the size.

| Variable | Default |
| --- | --- |
| `WIRETAP_PORT` | `8317` |
| `WIRETAP_HOST` | `127.0.0.1` |
| `WIRETAP_DIR` | `~/.local/share/agent-tap` |
| `WIRETAP_UPSTREAM` | `https://api.anthropic.com` |
| `WIRETAP_CODEX_UPSTREAM` | `https://chatgpt.com/backend-api/codex` |
| `WIRETAP_CA` | macOS system roots |

## Troubleshooting

**`unable to get local issuer certificate`** — some Node builds ship an incomplete root
list (a Homebrew Node 26 on macOS has no GlobalSign root, and then *every* HTTPS call
from Node fails, not just this tool). agent-tap adds the macOS system roots at start and
caches them. Verification is never turned off. `WIRETAP_CA` points at another bundle.

## Develop

```bash
node --test test/proxy.test.mjs   # fake API, no network
cd ui && npm run build            # viewer → viewer/dist, committed on purpose
```

The proxy is one file, `server.mjs`, with no dependency. The viewer is React and
shadcn/ui under `ui/`. Adding a client needs three things: a base-URL setting, an entry
in the `PROVIDERS` table, and a reply-stream reader. Pull requests welcome.

## Licence

MIT — see [LICENSE](LICENSE).
