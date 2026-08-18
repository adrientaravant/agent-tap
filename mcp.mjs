#!/usr/bin/env node
// agent-tap — MCP server over the captured sessions.
//
// Lets an agent (Claude Code, or anything that speaks MCP over stdio) ask
// questions about a captured session: which tools ran, what the system
// prompt held, what a turn said. Read-only: every tool here reads record
// files and nothing else. Register with:
//
//   claude mcp add agent-tap -- node /path/to/agent-tap/mcp.mjs
//
// Plain Node, no dependency, newline-delimited JSON-RPC on stdio.

import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  DATA_DIR,
  safeName,
  readSession,
  viewOf,
  callsOf,
  kindOf,
  titleOf,
  summarise,
} from './server.mjs'

// A tool reply is text for a model, so cap it instead of flooding the
// context. The caller can narrow with seq / part / query.
const CAP = 50_000

function capped(text) {
  if (text.length <= CAP) return text
  return (
    text.slice(0, CAP) +
    `\n\n[truncated: ${(text.length - CAP).toLocaleString('en-US')} more characters — narrow with seq, part or query]`
  )
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? null, null, 2)
  return content
    .map((c) => {
      if (c?.type === 'text') return c.text ?? ''
      if (c?.type === 'thinking') return '[thinking]\n' + (c.thinking ?? '')
      if (c?.type === 'tool_use') return `[tool_use ${c.name}]\n` + JSON.stringify(c.input, null, 2)
      if (c?.type === 'tool_result')
        return `[tool_result${c.is_error ? ' ERROR' : ''}]\n` + blockText(c.content)
      return JSON.stringify(c, null, 2)
    })
    .join('\n\n')
}

// The searchable parts of one record, each labelled with where it lives.
function partsOf(rec) {
  const view = viewOf(rec)
  const out = []
  view.system.forEach((b, i) => out.push({ part: `system[${i}]`, text: b.text ?? '' }))
  view.tools.forEach((t) =>
    out.push({ part: `tool ${t.name}`, text: `${t.name}\n${t.description ?? ''}` })
  )
  view.messages.forEach((m, i) =>
    out.push({ part: `message[${i}] ${m.role}${m.name ? ' ' + m.name : ''}`, text: blockText(m.content) })
  )
  out.push({ part: 'reply', text: rec.response?.text ?? '' })
  return out
}

async function mustReadSession(file) {
  const name = safeName(file)
  if (!name) throw new Error(`bad file name: ${file}`)
  return readSession(name)
}

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List every captured session: file name, thread title, client, model, call count. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const files = (await fsp.readdir(DATA_DIR)).filter((f) => f.endsWith('.ndjson'))
      const out = []
      for (const f of files) {
        const st = await fsp.stat(path.join(DATA_DIR, f))
        const recs = await readSession(f).catch(() => [])
        out.push({
          file: f,
          title: titleOf(recs),
          provider: recs[0]?.provider ?? 'anthropic',
          model: recs.at(-1)?.model ?? null,
          calls: recs.length,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
        })
      }
      out.sort((a, b) => b.mtime.localeCompare(a.mtime))
      return JSON.stringify(out, null, 2)
    },
  },
  {
    name: 'list_calls',
    description:
      'List the API calls of one session in time order: seq, kind (conversation or background job), message count, which tools the reply ran, token usage. Use the seq numbers with read_call.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'file name from list_sessions' } },
      required: ['file'],
      additionalProperties: false,
    },
    run: async ({ file }) => {
      const recs = await mustReadSession(file)
      return JSON.stringify(
        recs.map((r) => {
          const s = summarise(r)
          return {
            seq: s.seq,
            ts: s.ts,
            kind: s.kind,
            status: s.status,
            messages: s.messages,
            tools_offered: s.tools,
            tool_calls: s.tool_calls,
            usage: s.usage,
          }
        }),
        null,
        2
      )
    },
  },
  {
    name: 'read_call',
    description:
      'Read one part of one call. part: "conversation" (the messages, readable), "system" (the system prompt), "tools" (tool names and descriptions), "tool_runs" (each tool call paired with its result), "reply" (what the model answered), "params" (model parameters and headers). Long output is truncated; narrow with search_session first.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        seq: { type: 'number' },
        part: {
          type: 'string',
          enum: ['conversation', 'system', 'tools', 'tool_runs', 'reply', 'params'],
        },
      },
      required: ['file', 'seq', 'part'],
      additionalProperties: false,
    },
    run: async ({ file, seq, part }) => {
      const recs = await mustReadSession(file)
      const rec = recs.find((r) => r.seq === seq)
      if (!rec) throw new Error(`no call with seq ${seq} in ${file}`)
      const view = viewOf(rec)
      if (part === 'system')
        return capped(view.system.map((b, i) => `# system[${i}]\n${b.text ?? ''}`).join('\n\n'))
      if (part === 'tools')
        return capped(
          view.tools.map((t) => `# ${t.name}\n${t.description ?? ''}`).join('\n\n') || '(no tools)'
        )
      if (part === 'conversation')
        return capped(
          view.messages
            .map((m, i) => `# [${i}] ${m.role}${m.name ? ' → ' + m.name : ''}\n${blockText(m.content)}`)
            .join('\n\n') || '(no messages)'
        )
      if (part === 'tool_runs')
        return capped(
          callsOf(rec, view)
            .map(
              (c) =>
                `# ${c.index + 1}. ${c.name}${c.is_error ? ' (FAILED)' : ''}\n## input\n${c.input}\n## result\n${c.output ?? '(still running when this call was made)'}`
            )
            .join('\n\n') || '(no tool runs)'
        )
      if (part === 'reply')
        return capped(
          [
            rec.response?.text ?? '',
            rec.response?.thinking ? '[thinking]\n' + rec.response.thinking : '',
            rec.response?.tool_calls?.length
              ? '[tool calls]\n' + JSON.stringify(rec.response.tool_calls, null, 2)
              : '',
          ]
            .filter(Boolean)
            .join('\n\n') || '(empty reply)'
        )
      const rest = { ...rec.request }
      delete rest.system
      delete rest.tools
      delete rest.messages
      delete rest.input
      return capped(
        JSON.stringify({ params: rest, request_headers: rec.request_headers, status: rec.response?.status, stop_reason: rec.response?.stop_reason, usage: rec.response?.usage }, null, 2)
      )
    },
  },
  {
    name: 'search_session',
    description:
      'Case-insensitive text search across every call of a session: system prompts, tool definitions, messages, replies. Returns seq, the part that matched, and an excerpt. Use it to answer "did it use X" before reading whole calls.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        query: { type: 'string', description: 'plain text, not a regex' },
      },
      required: ['file', 'query'],
      additionalProperties: false,
    },
    run: async ({ file, query }) => {
      const recs = await mustReadSession(file)
      const q = query.toLowerCase()
      const hits = []
      for (const rec of recs) {
        for (const { part, text } of partsOf(rec)) {
          const at = text.toLowerCase().indexOf(q)
          if (at === -1) continue
          const from = Math.max(0, at - 80)
          hits.push({
            seq: rec.seq,
            kind: kindOf(rec),
            part,
            excerpt: text.slice(from, at + query.length + 160).replace(/\s+/g, ' '),
          })
          if (hits.length >= 60) break
        }
        if (hits.length >= 60) break
      }
      if (!hits.length) return `no match for ${JSON.stringify(query)} in ${file}`
      const note = hits.length >= 60 ? '\n\n[stopped at 60 matches — narrow the query]' : ''
      return JSON.stringify(hits, null, 2) + note
    },
  },
]

// ------------------------------------------------------- JSON-RPC on stdio

const respond = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const fail = (id, code, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-tap', version: '1.0.0' },
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return respond(id, {})
  if (method === 'tools/list') {
    return respond(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`)
    try {
      const text = await tool.run(params?.arguments ?? {})
      return respond(id, { content: [{ type: 'text', text }], isError: false })
    } catch (err) {
      return respond(id, { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true })
    }
  }
  if (id != null) return fail(id, -32601, `unknown method: ${method}`)
}

// The client closes stdin to stop the server. A tool call may still be
// reading a file at that moment, so drain the in-flight work before exiting.
let buffer = ''
let inFlight = 0
let closing = false
const maybeExit = () => {
  if (closing && inFlight === 0) process.exit(0)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    inFlight++
    handle(msg)
      .catch((err) => {
        if (msg.id != null) fail(msg.id, -32603, String(err?.message ?? err))
      })
      .finally(() => {
        inFlight--
        maybeExit()
      })
  }
})
process.stdin.on('end', () => {
  closing = true
  maybeExit()
})
