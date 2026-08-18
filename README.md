# agent-tap

See what **Claude Code** and **Codex** actually send to the model: the full system
prompt, every tool schema, the cache breakpoints, and the token counts — with a viewer
to read it.

The session files in `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/*.jsonl`
hold the conversation, but not the wire payload. This is a small proxy that sits
between the client and the API, copies each request body to a file, and forwards the
call unchanged.

Everything stays on your machine. Nothing is sent anywhere except to the API the client
was already calling, and credentials are stripped before anything is written to disk.

> **What lands on disk.** A record holds the entire request: system prompt, tool
> schemas, every message, and the reply. That is the point of the tool, and it means
> the files contain whatever your session contained — file contents, command output,
> and any secret a tool result happened to print. Credentials in headers are replaced
> with `[redacted N chars]` before writing, and a test enforces it, but the body is
> kept verbatim. Treat `~/.local/share/agent-tap/` as private, and never paste a
> record into a shared channel without reading it first.

## Install and run

```bash
npx agent-tap on
```

Then start a session in a terminal — `claude` or `codex` — and open the viewer:

```bash
npx agent-tap open
```

When you have seen enough:

```bash
npx agent-tap off
```

From a clone instead:

```bash
git clone https://github.com/adrientaravant/agent-tap
cd agent-tap && npm link     # gives you the `wiretap` command
wiretap on
```

Requires Node 20 or later. No dependency is installed for the proxy itself.

## What `on` changes

Capture is a temporary state, not a permanent setup. `on` starts the proxy and routes
new sessions to it:

| Client | What is written | Undone by |
| --- | --- | --- |
| Claude Code | `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` | `wiretap off` |
| Codex | a `model_providers.wiretap` block in `~/.codex/config.toml`, between two markers | `wiretap off` |

Both files are backed up to `.bak` first, and an on/off cycle leaves them
byte-identical. Only sessions started **after** the switch are captured; sessions
already open keep their old setting.

```bash
wiretap status   # proxy, both routes, number of captured sessions
wiretap open     # the viewer
wiretap tail     # the proxy log
wiretap off      # stop, and restore direct calls
```

For one session only, with no global change:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 claude
```

### After a reboot

The proxy is a process and dies with the machine; the routing lives in files and
survives. That pair is the one bad state: new sessions try to reach a proxy that is not
running and fail to connect. Run `wiretap on` before you work, or `wiretap off` when
you finish. `wiretap status` warns when routing is on and the proxy is down.

### Codex looks nothing like Claude Code on the wire

Measured, not read in documentation. With a ChatGPT sign-in, Codex sends:

- **no tool definitions in `tools`** — they ride inside `input[0]` as an
  `additional_tools` item;
- **no `instructions`** — the system prompt is a set of developer messages inside
  `input`;
- **no cache markers** — that API caches on its own and reports only `cached_tokens`,
  grouped by a `prompt_cache_key`;
- **no `content-type` on the reply**, so a stream has to be recognised from the request.

The server normalises both clients into one shape when a record is read, so the viewer
has a single implementation. The stored record is never rewritten: the Raw tab always
shows exactly what crossed the wire.

### The Claude desktop app cannot be captured

Measured on 2026-08-17, not read in documentation. The app process itself does
inherit the variable — `launchctl setenv ANTHROPIC_BASE_URL …` reaches it — but
the app overrides it for every session it spawns:

```
app process     ANTHROPIC_BASE_URL=http://127.0.0.1:8317
session it runs ANTHROPIC_BASE_URL=https://api.anthropic.com
```

So no setting at any level captures a desktop session. Only a terminal session
can be routed. Capturing the app would need TLS interception of
`api.anthropic.com` — a local certificate authority in the keychain, a hosts
entry, and the proxy on port 443. That is out of scope here.

### While capture is on

Every new session depends on the proxy. If the proxy is not running, those
sessions fail to connect. `wiretap status` reports that state and tells you how
to fix it. After a reboot the proxy is gone but the variables remain, so run
`wiretap on` or `wiretap off` before you work.

## What the viewer shows

Every panel carries a badge saying where its content comes from: **on the wire** means
the captured payload, **computed** means wiretap built it. Numbers and terms have a
hover explanation of what they mean in the harness.

- **Sessions** — one file per Claude Code session, newest first.
- **Calls** — model, tool count, cache read and write, duration.
- **What this call is** — one prompt of yours produces several API calls. Only one is
  the conversation; the others are background jobs such as the title generator or the
  state check that drives the idle indicator. wiretap reads the system prompt to tell
  them apart and labels each call.
- **System / Tools / Messages** — the payload, with an outline beside it. A session can
  send more than two hundred tool schemas, so the outline filters by name and by
  description, and marks cache breakpoints and blocks that are new this turn.
- **Params / Reply / Raw** — parameters, headers, the reply, and the stored record.
- **Diff** — this call against the previous call **of the same shape**, so a
  conversation turn is never compared with a background job.

### Building the viewer

The viewer is a React app built with shadcn/ui. The proxy itself keeps no dependency;
the UI build is separate and produces static files in `viewer/dist`.

```bash
cd ui && npm install && npm run build
```

`npm run dev` runs Vite with the API proxied to port 8317.

## Storage

One NDJSON file per session, one line per call:

```
~/.local/share/agent-tap/<date>_<session-id>.ndjson
```

The session id comes from `metadata.user_id` in the request body. If the body has no
session id, the file name uses a hash of the start of the conversation.

Delete a file to remove a session. Nothing rotates the directory automatically, so
check its size from time to time.

## Credentials

The proxy receives the `Authorization` header. It forwards the header unchanged to the
API and replaces it with `[redacted N chars]` before it writes the record. The same
applies to `x-api-key`, cookies, and any header whose name ends in `-token`, `-secret`,
or `-api-key`. A test asserts that no credential reaches the disk.

Response bodies are recorded in full. If a tool result in the conversation contains a
secret, that secret is in the file. The directory holds the full text of your sessions —
treat it as private.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WIRETAP_PORT` | `8317` | Listen port |
| `WIRETAP_HOST` | `127.0.0.1` | Listen address |
| `WIRETAP_UPSTREAM` | `https://api.anthropic.com` | Where calls go |
| `WIRETAP_DIR` | `~/.local/share/agent-tap` | Where records go |
| `WIRETAP_CA` | macOS system roots | Extra root certificates, PEM file |

## Certificates

The Homebrew Node 26.5.0 on this machine ships a root list of 120 certificates
with no GlobalSign and no Google Trust Services root. Every HTTPS call from that
Node fails with `unable to get local issuer certificate`, including the calls
this proxy forwards. It is not specific to this tool:

```bash
node -e "require('https').get('https://www.google.com/',r=>console.log(r.statusCode)).on('error',e=>console.log(e.message))"
```

At start the proxy adds the macOS system roots to Node's own list, and caches
them in `system-ca.pem` for 30 days. Verification stays on. `WIRETAP_CA`
replaces the source if you need another bundle.

## Test

```bash
node --test test/proxy.test.mjs
```

The suite starts a fake API and the real proxy, then checks that the reply passes
through unchanged, that the SSE stream is not buffered, that credentials do not reach
the disk, and that the viewer API refuses a path outside the data directory.

## Contributing

Issues and pull requests welcome. The proxy has no dependency and the test suite runs
against a fake API, so `node --test test/proxy.test.mjs` is the whole loop. If you touch
the viewer, run `cd ui && npm run build` and commit `viewer/dist` — it is committed on
purpose so the tool runs without a build step.

Ports for other clients are welcome. A client needs three things: a base-URL setting, a
prefix in the `PROVIDERS` table in `server.mjs`, and a reply-stream reader.

## Licence

MIT. See [LICENSE](LICENSE).
