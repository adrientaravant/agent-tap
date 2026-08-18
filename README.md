# agent-tap

See the data that your coding agent sends to the model.

Claude Code and Codex write session files. But these files do not contain the wire
payload. The system prompt, the tool schemas, the cache markers, and the true token
counts are not in them. `agent-tap` is a small local proxy between the client and the
API. It writes each request to a file. It sends the call to the API without changes.
It streams the reply back without a buffer. A viewer shows the result.

All data stays on your machine. No dependency, no build step, no hosting.

> **Warning.** A record contains the full session: prompts, file contents, command
> output. The proxy redacts the credentials in the headers before it writes, and a
> test makes sure of this. But the body stays complete. Keep
> `~/.local/share/agent-tap/` private.

## Install

Run it directly from GitHub:

```bash
npx github:adrientaravant/agent-tap on
```

Or clone it:

```bash
git clone https://github.com/adrientaravant/agent-tap
cd agent-tap && npm link
```

`npm link` puts two commands on your PATH: `agent-tap` and `wiretap`. They are the
same tool. You need Node 20 or later. macOS and Linux. The tool is not on npm, so
plain `npx agent-tap` will not find it.

## Use

```bash
agent-tap on          # start the capture
claude                # …or codex
agent-tap open        # read the captured data
agent-tap off         # stop, and restore direct calls
```

Other commands: `status`, `clear` (delete all records), `tail` (show the proxy log).

The proxy captures Codex sessions from the terminal and from the app. It captures
Claude sessions only from the terminal: the desktop app sets its own API host for
each session it starts.

## The viewer

The left column shows the sessions, each with the name of its thread. The middle
column shows the calls. One prompt makes more than one API call. The viewer tells
you which call is the conversation and which is a background job. Each call has
these tabs:

- **Conversation** — the exchange as a chat. Thinking, tool runs, and harness notes
  fold to one line each.
- **Context** — the parts that fill the prompt, and the growth of the token counts
  through the session.
- **System, Tools, Messages, Raw** — the payload itself, with a list you can filter.
- **Diff** — the changes between this call and the call before it.
- **ask an agent** — copies a prompt that contains the path of the record file.
  Paste it into Claude Code and ask your questions, for example "did it use the X
  skill and how". The viewer itself has no model and no key.

Each panel has a label: **on the wire** (captured) or **computed** (made by
agent-tap). Terms such as *cache write* show an explanation when you point at them.

## What `on` changes

For Claude Code, it sets `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`. For
Codex, it writes a `model_providers` block in `~/.codex/config.toml` between two
markers. The tool makes a backup of each file first. `off` restores the files byte
for byte. Only sessions that start after the switch are captured.

After a reboot, run `on` again. The proxy stops with the machine, but the routing
stays in the files. `status` shows a warning for this state.

For one session only, with no global change:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 claude
```

## Limits

- A tool call shows its result when the next request contains it. Thus the last call
  of a turn has no result yet. A session that stops on a tool call never sends that
  result.
- Codex and Claude are very different on the wire. Codex puts the tool schemas in
  `input[0]` and the system prompt in developer messages. Records are normalised
  when they are read, never rewritten. The Raw tab always shows the bytes from the
  wire.

## Storage

The proxy writes one NDJSON file for each session in `~/.local/share/agent-tap/`.
Nothing rotates, and a work session is tens of megabytes. Delete files with the
trash icon in the viewer, or with `agent-tap clear`.

These variables change the defaults: `WIRETAP_PORT` (8317), `WIRETAP_HOST`
(127.0.0.1), `WIRETAP_DIR`, `WIRETAP_UPSTREAM`, `WIRETAP_CODEX_UPSTREAM`,
`WIRETAP_CA`.

## Develop

```bash
node --test test/proxy.test.mjs   # fake API, no network
cd ui && npm run build            # viewer → viewer/dist, committed on purpose
```

The proxy is one file, `server.mjs`, in plain Node. The viewer is React and
shadcn/ui in `ui/`. If HTTPS fails with a certificate error, your Node has an
incomplete root list. agent-tap adds the macOS system roots itself, and it never
turns verification off. Pull requests are welcome.

## Licence

MIT — see [LICENSE](LICENSE).
