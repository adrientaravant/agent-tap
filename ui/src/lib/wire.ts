// Types and derivations over a captured record.
//
// Everything in `Record.request` and `Record.response` is what crossed the
// wire. Everything this file computes is labelled "derived" in the UI, so a
// reader never mistakes an interpretation for the payload.

export type Block = {
  type?: string
  id?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
  is_error?: boolean
  source?: { media_type?: string }
  cache_control?: { type: string }
}

export type Message = {
  role: string
  content: string | Block[]
  name?: string
  call_id?: string
  cache_control?: { type: string }
}

// One tool call paired with its result, computed by the server for both
// clients: Anthropic tool_use/tool_result, Codex custom_tool_call/output.
export type ToolCall = {
  index: number
  message: number
  name: string
  input: string
  output: string | null
  is_error: boolean
}

export type Tool = {
  name: string
  description?: string
  input_schema?: unknown
  cache_control?: { type: string }
}

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type CallView = { system: Block[]; tools: Tool[]; messages: Message[] }

export type WireRecord = {
  id: string
  kind?: string
  provider?: string
  // Normalised by the server so both clients render the same way. The raw
  // request stays in `request` and is what the Raw tab shows.
  view?: CallView
  calls?: ToolCall[]
  seq: number
  ts: string
  url: string
  model: string | null
  took_ms: number
  ttfb_ms: number | null
  request_headers: Record<string, string>
  response_headers: Record<string, string>
  request: {
    model?: string
    max_tokens?: number
    temperature?: number
    stream?: boolean
    thinking?: unknown
    system?: string | Block[]
    tools?: Tool[]
    messages?: Message[]
    metadata?: { user_id?: string }
    // Codex, on the Responses API.
    input?: unknown[]
    instructions?: string
    reasoning?: unknown
    text?: { verbosity?: string }
    service_tier?: string
    store?: boolean
    prompt_cache_key?: string
  }
  response: {
    status: number
    streamed?: boolean
    stop_reason?: string | null
    usage?: Usage
    text?: string
    thinking?: string
    tool_calls?: { name?: string; id?: string; input?: unknown }[]
    body?: unknown
    error?: { message: string }
  }
}

export type CallSummary = {
  id: string
  provider?: string
  seq: number
  ts: string
  model: string | null
  url: string
  status: number
  took_ms: number
  ttfb_ms: number | null
  stop_reason: string | null
  tools: number
  messages: number
  usage: {
    input: number | null
    output: number | null
    cache_write: number | null
    cache_read: number | null
  }
  tool_calls: string[]
}

export type SessionInfo = {
  file: string
  provider?: string
  calls: number
  bytes: number
  mtime: string
  started: string | null
  model: string | null
  // The thread name: the captured title-generator reply when the session
  // has one, otherwise the first thing the user typed.
  title: string | null
  // "session" when the file holds a conversation; otherwise the background
  // job it holds ("title", "state", "other").
  kind?: string
}

// Codex names every shell run "exec", which makes a transcript unscannable.
// Pull the command out of the input so the fold title says what ran.
export function toolLabel(name: string, input: string) {
  if (!/^(exec|shell|bash|run)/i.test(name)) return name
  const m =
    /cmd:\s*"((?:[^"\\]|\\.)*)"/.exec(input) ??
    /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input) ??
    /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)
  if (!m) return name
  const cmd = m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\s+/g, " ").trim()
  return cmd ? `${name} · ${cmd.slice(0, 48)}` : name
}

export function viewOf(rec: WireRecord): CallView {
  if (rec.view) return rec.view
  return {
    system: systemBlocks(rec.request),
    tools: rec.request.tools ?? [],
    messages: rec.request.messages ?? [],
  }
}

export function systemBlocks(req: WireRecord["request"]): Block[] {
  const s = req?.system
  if (!s) return []
  return typeof s === "string" ? [{ type: "text", text: s }] : s
}

export function systemText(req: WireRecord["request"]): string {
  return systemBlocks(req)
    .map((b) => b.text ?? "")
    .join("\n")
}

export function blockText(content: string | Block[] | unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2)
  return (content as Block[])
    .map((c) => {
      if (c.type === "text") return c.text ?? ""
      if (c.type === "thinking") return "[thinking]\n" + (c.thinking ?? "")
      if (c.type === "tool_use") return `[tool_use ${c.name}]\n` + JSON.stringify(c.input, null, 2)
      if (c.type === "tool_result")
        return `[tool_result${c.is_error ? " ERROR" : ""}]\n` + blockText(c.content)
      if (c.type === "image") return `[image ${c.source?.media_type ?? ""}]`
      return JSON.stringify(c, null, 2)
    })
    .join("\n\n")
}

export function replyText(res: WireRecord["response"]): string {
  if (res?.text) return res.text
  const content = (res?.body as { content?: Block[] } | undefined)?.content
  if (Array.isArray(content)) return blockText(content)
  return typeof res?.body === "string" ? res.body : ""
}

export type Breakpoint = { where: string; type: string; kind: "system" | "tools" | "messages" }

export function cacheBreakpoints(req: WireRecord["request"]): Breakpoint[] {
  const out: Breakpoint[] = []
  systemBlocks(req).forEach((b, i) => {
    if (b.cache_control) out.push({ where: `system[${i}]`, type: b.cache_control.type, kind: "system" })
  })
  ;(req.tools ?? []).forEach((t, i) => {
    if (t.cache_control)
      out.push({ where: `tools[${i}] ${t.name}`, type: t.cache_control.type, kind: "tools" })
  })
  ;(req.messages ?? []).forEach((m, i) => {
    if (m.cache_control)
      out.push({ where: `messages[${i}]`, type: m.cache_control.type, kind: "messages" })
    if (Array.isArray(m.content))
      m.content.forEach((c, j) => {
        if (c.cache_control)
          out.push({
            where: `messages[${i}].content[${j}]`,
            type: c.cache_control.type,
            kind: "messages",
          })
      })
  })
  return out
}

// The server decides which job a call is doing, so the rule lives in one
// place. This maps its answer to words for the reader.
export type KindKey = "session" | "title" | "state" | "summary" | "other"

const KINDS: Record<KindKey, { label: string; why: string }> = {
  session: {
    label: "your session",
    why: "The conversation itself: the full tool set and the full system prompt.",
  },
  title: {
    label: "title generator",
    why: "A background call that writes the thread title shown in the app. agent-tap uses its reply to name the session in the list.",
  },
  state: {
    label: "status updater",
    why: "A background call that writes the short status line the app shows while the agent works. It is not part of the conversation.",
  },
  summary: {
    label: "summariser",
    why: "A background call that compacts the conversation. No tools, small budget.",
  },
  other: {
    label: "background call",
    why: "No tool set and a small budget, so this is not the conversation.",
  },
}

export function describeKind(rec: WireRecord) {
  const kind = KINDS[(rec.kind as KindKey) ?? "other"] ?? KINDS.other
  const v = viewOf(rec)
  if (rec.kind === "session")
    return {
      ...kind,
      why: `The conversation itself: ${v.tools.length} tool definitions and ${v.system.length} system blocks.`,
    }
  return kind
}

// The conversation as a person would read it: who said what, in order,
// with tool runs paired to their results. Derived from the normalised
// view, so one walk serves both clients.
export type TranscriptItem = {
  kind: "user" | "assistant" | "thinking" | "tool" | "note"
  // The spoken text, or the tool input for kind "tool".
  text: string
  name?: string
  output?: string | null
  is_error?: boolean
}

export function transcriptOf(view: CallView): TranscriptItem[] {
  const out: TranscriptItem[] = []
  const msgs = view.messages ?? []

  // Pair every result with its call up front, in either client's shape.
  const blockResults = new Map<string, { text: string; is_error: boolean }>()
  const codexResults = new Map<string, string>()
  for (const m of msgs) {
    if (m.role === "tool" && m.call_id && typeof m.content === "string")
      codexResults.set(m.call_id, m.content)
    if (!Array.isArray(m.content)) continue
    for (const c of m.content)
      if (c.type === "tool_result" && c.tool_use_id)
        blockResults.set(c.tool_use_id, { text: blockText(c.content), is_error: !!c.is_error })
  }

  const push = (item: TranscriptItem) => {
    if (item.text || item.kind === "tool") out.push(item)
  }

  for (const m of msgs) {
    // Codex shapes: a named assistant message is a tool call, a "tool"
    // message is its result, "reasoning" is thinking.
    if (m.role === "assistant" && m.name && typeof m.content === "string") {
      push({
        kind: "tool",
        name: m.name,
        text: m.content,
        output: m.call_id ? (codexResults.get(m.call_id) ?? null) : null,
      })
      continue
    }
    if (m.role === "tool") continue
    if (m.role === "reasoning") {
      push({ kind: "thinking", text: blockText(m.content) })
      continue
    }

    if (typeof m.content === "string") {
      push({ kind: roleKind(m.role, m.content), text: m.content })
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const c of m.content) {
      if (c.type === "text") push({ kind: roleKind(m.role, c.text ?? ""), text: c.text ?? "" })
      else if (c.type === "thinking") push({ kind: "thinking", text: c.thinking ?? "" })
      else if (c.type === "tool_use") {
        const paired = blockResults.get(c.id ?? "")
        push({
          kind: "tool",
          name: c.name ?? "tool",
          text: JSON.stringify(c.input ?? {}, null, 2),
          output: paired?.text ?? null,
          is_error: paired?.is_error,
        })
      } else if (c.type === "tool_result") {
        // Already paired with its call above.
        continue
      } else if (c.type === "image") {
        push({ kind: "note", text: `[image ${c.source?.media_type ?? ""}]` })
      } else push({ kind: "note", text: JSON.stringify(c, null, 2) })
    }
  }
  return out
}

// Harness notes ride inside user messages. They are not the person talking,
// so the transcript folds them away. Claude Code wraps them in tags; Codex
// sends instructions and environment context as plain user text.
const NOTE_PREFIXES = [
  "<system-reminder>",
  "<task-notification>",
  "<INSTRUCTIONS>",
  "<environment_context>",
  "<user_instructions>",
  "<turn_context>",
  "<recommended_plugins>",
  "<permissions",
  "# AGENTS.md instructions",
  "# Files mentioned by the user",
]

function roleKind(role: string, text: string): TranscriptItem["kind"] {
  if (role === "assistant") return "assistant"
  if (role !== "user") return "note"
  const t = text.trimStart()
  if (NOTE_PREFIXES.some((p) => t.startsWith(p))) return "note"
  return "user"
}

// A line diff over the common prefix and suffix. Enough to read a
// turn-to-turn delta without a diff library.
export type DiffRow = { kind: "add" | "del" | "ctx" | "hunk"; text: string }

export function diffLines(aText: string, bText: string, ctx = 3): DiffRow[] {
  const a = aText.split("\n")
  const b = bText.split("\n")
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  const rows: DiffRow[] = []
  if (s > ctx) rows.push({ kind: "hunk", text: `${s - ctx} identical lines above` })
  for (let i = Math.max(0, s - ctx); i < s; i++) rows.push({ kind: "ctx", text: a[i] })
  for (let i = s; i < a.length - e; i++) rows.push({ kind: "del", text: a[i] })
  for (let i = s; i < b.length - e; i++) rows.push({ kind: "add", text: b[i] })
  const tail = b.length - e
  for (let i = tail; i < Math.min(b.length, tail + ctx); i++) rows.push({ kind: "ctx", text: b[i] })
  if (e > ctx) rows.push({ kind: "hunk", text: `${e - ctx} identical lines below` })
  return rows
}

export const toolsText = (v: CallView) =>
  (v.tools ?? [])
    .map((t) => `# ${t.name}\n${t.description ?? ""}\n${JSON.stringify(t.input_schema ?? {}, null, 2)}`)
    .join("\n\n")

export const messagesText = (v: CallView) =>
  (v.messages ?? []).map((m, i) => `# [${i}] ${m.role}\n${blockText(m.content)}`).join("\n\n")

export const systemTextOf = (v: CallView) =>
  (v.system ?? []).map((b, i) => `# system[${i}]\n${b.text ?? ""}`).join("\n\n")

export const paramsText = (req: WireRecord["request"]) => {
  const rest = { ...req } as Record<string, unknown>
  delete rest.system
  delete rest.tools
  delete rest.messages
  return JSON.stringify(rest, null, 2)
}

export const fmtNum = (v: number | null | undefined) =>
  v == null ? "–" : new Intl.NumberFormat("en-US").format(v)

export const fmtMs = (v: number | null | undefined) =>
  v == null ? "–" : v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms"

export const fmtBytes = (b: number) =>
  b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1024) + " kB"

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB")
