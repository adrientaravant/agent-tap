// Types and derivations over a captured record.
//
// Everything in `Record.request` and `Record.response` is what crossed the
// wire. Everything this file computes is labelled "derived" in the UI, so a
// reader never mistakes an interpretation for the payload.

export type Block = {
  type?: string
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

export type Message = { role: string; content: string | Block[]; cache_control?: { type: string } }

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
    why: 'A background call asking for "a concise, sentence-case title (3-7 words)". Its reply becomes the name of the session.',
  },
  state: {
    label: "state check",
    why: "A background call that reads the tail of the reply and decides whether the agent is working, done, blocked, or waiting. It drives the idle indicator.",
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
