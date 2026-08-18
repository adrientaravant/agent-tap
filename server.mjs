#!/usr/bin/env node
// agent-tap — local capture proxy for Claude Code.
// Records the full request body sent to the Anthropic API, forwards the call
// unchanged, and streams the reply back without a buffer.

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.WIRETAP_PORT || 8317)
const HOST = process.env.WIRETAP_HOST || '127.0.0.1'
const UPSTREAM = new URL(process.env.WIRETAP_UPSTREAM || 'https://api.anthropic.com')

// One port, several clients. A path prefix picks the upstream, so a single
// proxy captures Claude Code and Codex side by side.
//   Claude Code  ANTHROPIC_BASE_URL=http://127.0.0.1:8317
//   Codex        base_url = "http://127.0.0.1:8317/codex"   (ChatGPT sign-in)
//   OpenAI key   base_url = "http://127.0.0.1:8317/openai/v1"
const PROVIDERS = [
  {
    id: 'codex',
    prefix: '/codex',
    upstream: new URL(process.env.WIRETAP_CODEX_UPSTREAM || 'https://chatgpt.com/backend-api/codex'),
  },
  {
    id: 'openai',
    prefix: '/openai',
    upstream: new URL(process.env.WIRETAP_OPENAI_UPSTREAM || 'https://api.openai.com'),
  },
  { id: 'anthropic', prefix: '', upstream: UPSTREAM },
]

function providerFor(pathname) {
  for (const p of PROVIDERS) {
    if (p.prefix && (pathname === p.prefix || pathname.startsWith(p.prefix + '/'))) return p
  }
  return PROVIDERS.at(-1)
}
const DATA_DIR =
  process.env.WIRETAP_DIR ||
  path.join(os.homedir(), '.local', 'share', 'agent-tap')

// Headers that carry credentials or identity. They never reach the disk.
const REDACT = /^(authorization|proxy-authorization|x-api-key|cookie|set-cookie|anthropic-auth-token|x-anthropic-auth|.*-api-key|.*-token|.*-secret)$/i

fs.mkdirSync(DATA_DIR, { recursive: true })

// --------------------------------------------------------------- trust store

// Some Node builds ship an incomplete root list. A Homebrew Node 26 on macOS
// has no GlobalSign or Google Trust Services root, so every call to the API
// fails with "unable to get local issuer certificate". Add the macOS system
// roots to the list instead of turning verification off.
const CA_CACHE = path.join(DATA_DIR, 'system-ca.pem')
const CA_MAX_AGE = 30 * 24 * 3600 * 1000

function systemRoots() {
  if (process.env.WIRETAP_CA) return fs.readFileSync(process.env.WIRETAP_CA, 'utf8')
  if (process.platform !== 'darwin') return null
  try {
    const age = Date.now() - fs.statSync(CA_CACHE).mtimeMs
    if (age < CA_MAX_AGE) return fs.readFileSync(CA_CACHE, 'utf8')
  } catch {}
  try {
    const pem = execFileSync(
      'security',
      ['find-certificate', '-a', '-p', '/System/Library/Keychains/SystemRootCertificates.keychain'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    )
    fs.writeFileSync(CA_CACHE, pem)
    return pem
  } catch (err) {
    process.stderr.write(`wiretap: could not read the system roots: ${err}\n`)
    return null
  }
}

function buildAgent(target = UPSTREAM) {
  if (target.protocol !== 'https:') return null
  const ca = [...tls.rootCertificates]
  const extra = systemRoots()
  if (extra) {
    for (const part of extra.split(/(?=-----BEGIN CERTIFICATE-----)/)) {
      if (part.includes('BEGIN CERTIFICATE')) ca.push(part.trim() + '\n')
    }
  }
  return new https.Agent({ ca, keepAlive: true, maxSockets: 64 })
}

const AGENTS = new Map()
function agentFor(target) {
  if (!AGENTS.has(target.origin)) AGENTS.set(target.origin, buildAgent(target))
  return AGENTS.get(target.origin)
}

// ---------------------------------------------------------------- utilities

function redactHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (REDACT.test(k)) out[k] = `[redacted ${String(v).length} chars]`
    else out[k] = v
  }
  return out
}

function sessionKeyOf(body, headers, provider = 'anthropic') {
  if (provider !== 'anthropic') {
    // Codex identifies a conversation with a header. The body carries no id:
    // it resends the whole input array every turn.
    const h =
      headers['session-id'] ||
      headers['session_id'] ||
      headers['thread-id'] ||
      body?.client_metadata?.session_id ||
      body?.prompt_cache_key
    if (h) return String(h)
    const seed = JSON.stringify([body?.instructions, body?.input?.[0]])
    return 'anon-' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)
  }
  const uid = body?.metadata?.user_id
  if (typeof uid === 'string') {
    // Claude Code sends a JSON object as a string:
    // {"device_id":…,"account_uuid":…,"session_id":"<uuid>"}
    try {
      const parsed = JSON.parse(uid)
      if (parsed?.session_id) return String(parsed.session_id)
    } catch {}
    // Older builds use a flat string: user_…_session_<uuid>
    const m = uid.match(/session[_-](?!id)([0-9a-fA-F-]{8,})/)
    if (m) return m[1]
  }
  const h = headers['x-session-id'] || headers['x-claude-session-id']
  if (h) return String(h)
  // Fallback: a stable hash of the opening of the conversation.
  const seed = JSON.stringify([body?.system, body?.messages?.[0]])
  return 'anon-' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const openFiles = new Map()
function fileFor(session, when) {
  const name = `${stamp(when)}_${session}.ndjson`
  const full = path.join(DATA_DIR, name)
  if (!openFiles.has(full)) openFiles.set(full, { seq: countLines(full) })
  return { full, name, state: openFiles.get(full) }
}

function countLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return raw ? raw.split('\n').filter(Boolean).length : 0
  } catch {
    return 0
  }
}

function appendRecord(file, record) {
  fs.appendFileSync(file, JSON.stringify(record) + '\n')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ------------------------------------------------------- SSE reply analysis

// Collects usage, text and tool calls from the event stream while the bytes
// go straight to the client.
function makeStreamTap() {
  let buffer = ''
  const state = {
    model: null,
    stop_reason: null,
    usage: null,
    text: '',
    thinking: '',
    tool_calls: [],
    events: 0,
    error: null,
  }
  const blocks = new Map()

  function handle(data) {
    let ev
    try {
      ev = JSON.parse(data)
    } catch {
      return
    }
    state.events++
    switch (ev.type) {
      case 'message_start':
        state.model = ev.message?.model ?? state.model
        state.usage = { ...(ev.message?.usage || {}) }
        break
      case 'content_block_start':
        blocks.set(ev.index, { type: ev.content_block?.type, block: ev.content_block, json: '' })
        break
      case 'content_block_delta': {
        const b = blocks.get(ev.index) || {}
        const d = ev.delta || {}
        if (d.type === 'text_delta') state.text += d.text
        else if (d.type === 'thinking_delta') state.thinking += d.thinking
        else if (d.type === 'input_json_delta') b.json = (b.json || '') + d.partial_json
        blocks.set(ev.index, b)
        break
      }
      case 'content_block_stop': {
        const b = blocks.get(ev.index)
        if (b?.type === 'tool_use') {
          let input = null
          try {
            input = b.json ? JSON.parse(b.json) : {}
          } catch {
            input = { _unparsed: b.json }
          }
          state.tool_calls.push({ name: b.block?.name, id: b.block?.id, input })
        }
        break
      }
      case 'message_delta':
        state.stop_reason = ev.delta?.stop_reason ?? state.stop_reason
        if (ev.usage) state.usage = { ...(state.usage || {}), ...ev.usage }
        break
      case 'error':
        state.error = ev.error || ev
        break
    }
  }

  return {
    state,
    push(chunk) {
      buffer += chunk.toString('utf8')
      let i
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trimEnd()
        buffer = buffer.slice(i + 1)
        if (line.startsWith('data:')) handle(line.slice(5).trim())
      }
    },
  }
}

// The OpenAI Responses stream, used by Codex. Different event names, same
// job: collect usage, text, reasoning and tool calls while the bytes pass
// straight through. Usage is normalised to the Anthropic field names so the
// viewer has one shape to read; the untouched numbers stay in usage_raw.
function makeResponsesTap() {
  let buffer = ''
  const state = {
    model: null,
    stop_reason: null,
    usage: null,
    usage_raw: null,
    text: '',
    thinking: '',
    tool_calls: [],
    events: 0,
    error: null,
  }

  function normalise(u) {
    if (!u) return null
    return {
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? null,
      // The Responses API caches automatically; nothing reports a write.
      cache_creation_input_tokens: null,
      reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? null,
    }
  }

  function handle(data) {
    if (data === '[DONE]') return
    let ev
    try {
      ev = JSON.parse(data)
    } catch {
      return
    }
    state.events++
    const r = ev.response
    switch (ev.type) {
      case 'response.created':
      case 'response.in_progress':
        state.model = r?.model ?? state.model
        break
      case 'response.output_text.delta':
        state.text += ev.delta ?? ''
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        state.thinking += ev.delta ?? ''
        break
      case 'response.output_item.done': {
        const item = ev.item
        if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
          let input = null
          try {
            input = item.arguments ? JSON.parse(item.arguments) : {}
          } catch {
            input = { _unparsed: item.arguments }
          }
          state.tool_calls.push({ name: item.name, id: item.call_id ?? item.id, input })
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete':
        state.model = r?.model ?? state.model
        state.stop_reason = r?.status ?? state.stop_reason
        state.usage_raw = r?.usage ?? null
        state.usage = normalise(r?.usage)
        break
      case 'response.failed':
      case 'error':
        state.error = ev.error ?? r?.error ?? ev
        break
    }
  }

  return {
    state,
    push(chunk) {
      buffer += chunk.toString('utf8')
      let i
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trimEnd()
        buffer = buffer.slice(i + 1)
        if (line.startsWith('data:')) handle(line.slice(5).trim())
      }
    },
  }
}

// ------------------------------------------------------------------- proxy

function proxy(req, res) {
  req.socket.setNoDelay(true)
  const started = Date.now()

  readBody(req).then((raw) => {
    let body = null
    const ctype = req.headers['content-type'] || ''
    if (raw.length && ctype.includes('json')) {
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        body = null
      }
    }

    const url = new URL(req.url, 'http://localhost')
    const provider = providerFor(url.pathname)
    const target = provider.upstream
    // Strip our prefix and keep the upstream's own base path.
    const rest = provider.prefix ? req.url.slice(provider.prefix.length) || '/' : req.url
    const upstreamPath = (target.pathname.replace(/\/$/, '') + rest) || '/'

    const headers = { ...req.headers }
    headers.host = target.host
    // Identity encoding keeps the reply readable for the tap. SSE is not
    // compressed by the API, so nothing is lost.
    headers['accept-encoding'] = 'identity'
    if (raw.length) headers['content-length'] = String(raw.length)

    const agent = target.protocol === 'https:' ? https : http
    const upstreamReq = agent.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: upstreamPath,
        headers,
        agent: agentFor(target) || undefined,
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers)
        res.flushHeaders?.()

        // The Codex backend answers with no content-type at all, so the
        // request is the reliable signal: it asked for a stream.
        const isSSE =
          String(up.headers['content-type'] || '').includes('event-stream') ||
          body?.stream === true ||
          String(req.headers.accept || '').includes('event-stream')
        const tap = isSSE
          ? provider.id === 'anthropic'
            ? makeStreamTap()
            : makeResponsesTap()
          : null
        const plain = []
        let ttfb = null

        up.on('data', (chunk) => {
          if (ttfb === null) ttfb = Date.now() - started
          res.write(chunk) // pass through first, parse after
          if (tap) tap.push(chunk)
          else if (plain.reduce((n, c) => n + c.length, 0) < 4_000_000) plain.push(chunk)
        })

        up.on('end', () => {
          res.end()
          let response
          if (tap) {
            response = { status: up.statusCode, streamed: true, ...tap.state }
          } else {
            const text = Buffer.concat(plain).toString('utf8')
            let json = null
            try {
              json = JSON.parse(text)
            } catch {}
            response = {
              status: up.statusCode,
              streamed: false,
              model: json?.model ?? null,
              stop_reason: json?.stop_reason ?? null,
              usage: json?.usage ?? null,
              body: json ?? text.slice(0, 100_000),
            }
          }
          record({ req, raw, body, started, ttfb, response, upHeaders: up.headers, provider })
        })

        up.on('error', (err) => {
          res.end()
          record({
            req,
            raw,
            body,
            started,
            ttfb,
            response: { status: 0, error: { message: String(err) } },
            upHeaders: up.headers,
            provider,
          })
        })
      }
    )

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: String(err) } }))
      record({
        req,
        raw,
        body,
        started,
        ttfb: null,
        response: { status: 502, error: { message: String(err) } },
        upHeaders: {},
        provider,
      })
    })

    if (raw.length) upstreamReq.write(raw)
    upstreamReq.end()
  })
}

function record({ req, raw, body, started, ttfb, response, upHeaders, provider }) {
  // Only calls with a JSON body are worth a record. Health checks are noise.
  if (!body) return
  const when = new Date(started)
  const id = provider?.id ?? 'anthropic'
  const session = (id === 'anthropic' ? '' : id + '-') + sessionKeyOf(body, req.headers, id)
  const { full, state } = fileFor(session, when)
  const rec = {
    id: crypto.randomUUID(),
    seq: state.seq++,
    provider: id,
    session,
    ts: when.toISOString(),
    took_ms: Date.now() - started,
    ttfb_ms: ttfb,
    method: req.method,
    url: req.url,
    model: body.model ?? null,
    bytes_out: raw.length,
    request_headers: redactHeaders(req.headers),
    response_headers: redactHeaders(upHeaders || {}),
    request: body,
    response,
  }
  try {
    appendRecord(full, rec)
  } catch (err) {
    process.stderr.write(`wiretap: write failed: ${err}\n`)
  }
  const u = response?.usage || {}
  process.stdout.write(
    `${new Date().toLocaleTimeString()}  ${String(response?.status).padEnd(3)} ` +
      `${(body.model || '-').padEnd(28)} in=${u.input_tokens ?? '-'} ` +
      `cw=${u.cache_creation_input_tokens ?? '-'} cr=${u.cache_read_input_tokens ?? '-'} ` +
      `out=${u.output_tokens ?? '-'}  ${rec.took_ms}ms  [${session.slice(0, 8)}]\n`
  )
}

// ------------------------------------------------------------------ viewer

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

function json(res, value, status = 200) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function safeName(name) {
  return /^[\w.\-]+\.ndjson$/.test(name) ? name : null
}

async function readSession(name) {
  const raw = await fsp.readFile(path.join(DATA_DIR, name), 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch {
        return { id: `bad-${i}`, seq: i, broken: true }
      }
    })
}

// One prompt produces several API calls and only one is the conversation.
// The system prompt is the honest signal, so the rule reads it. This is
// derived, never stored: it is computed when a record is read.
// ------------------------------------------------------------------- view
//
// The two clients send the same information in very different shapes. Codex
// puts its tool schemas inside an `additional_tools` item of the input array
// and its system prompt in developer messages. Normalising here, at read
// time, keeps one implementation and leaves the stored record untouched —
// the Raw tab still shows exactly what crossed the wire.

function textOfCodexContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (typeof content === 'object') return content.text ?? JSON.stringify(content, null, 2)
    return String(content)
  }
  return content
    .map((c) => (typeof c === 'string' ? c : (c.text ?? c.input_text ?? c.output_text ?? '')))
    .filter(Boolean)
    .join('\n')
}

function viewOf(rec) {
  const req = rec.request || {}
  if ((rec.provider ?? 'anthropic') === 'anthropic') {
    const s = req.system
    return {
      system: !s ? [] : typeof s === 'string' ? [{ type: 'text', text: s }] : s,
      tools: req.tools || [],
      messages: req.messages || [],
    }
  }
  const input = Array.isArray(req.input) ? req.input : []
  const system = []
  const tools = []
  const messages = []
  for (const item of input) {
    if (item?.type === 'additional_tools' && Array.isArray(item.tools)) {
      for (const t of item.tools) {
        tools.push({
          name: t.name,
          description: t.description,
          input_schema: t.parameters ?? t.input_schema ?? t.format ?? {},
        })
      }
      continue
    }
    const text = textOfCodexContent(item?.content)
    if (item?.role === 'developer') {
      system.push({ type: 'text', text })
      continue
    }
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      // A custom tool carries `input`; a function call carries `arguments`.
      const args = item.input ?? item.arguments ?? ''
      messages.push({
        role: 'assistant',
        name: item.name,
        call_id: item.call_id ?? item.id,
        content: typeof args === 'string' ? args : JSON.stringify(args, null, 2),
      })
      continue
    }
    if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      // The output is a list of content blocks, not a string.
      messages.push({
        role: 'tool',
        call_id: item.call_id ?? item.id,
        content: textOfCodexContent(item.output),
      })
      continue
    }
    if (item?.type === 'reasoning') {
      messages.push({ role: 'reasoning', content: textOfCodexContent(item.summary) || '[encrypted]' })
      continue
    }
    messages.push({ role: item?.role ?? item?.type ?? 'unknown', content: text })
  }
  return { system, tools, messages }
}

// The tool calls of a conversation, paired with their results. This is the
// view a reader asks for first: what did the agent actually run?
function callsOf(rec, view) {
  const out = []
  if ((rec.provider ?? 'anthropic') === 'anthropic') {
    const results = new Map()
    for (const m of view.messages) {
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'tool_result') results.set(c.tool_use_id, c)
      }
    }
    view.messages.forEach((m, i) => {
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type !== 'tool_use') continue
        const r = results.get(c.id)
        out.push({
          index: out.length,
          message: i,
          name: c.name,
          input: JSON.stringify(c.input ?? {}, null, 2),
          output: r ? blockTextOf(r.content) : null,
          is_error: !!r?.is_error,
        })
      }
    })
    return out
  }
  const results = new Map()
  view.messages.forEach((m) => {
    if (m.role === 'tool' && m.call_id) results.set(m.call_id, m)
  })
  view.messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !m.name) return
    const r = m.call_id ? results.get(m.call_id) : null
    out.push({
      index: out.length,
      message: i,
      name: m.name,
      input: typeof m.content === 'string' ? m.content : '',
      output: r ? (typeof r.content === 'string' ? r.content : '') : null,
      is_error: /Script (failed|error)|error:/i.test(String(r?.content ?? '')),
    })
  })
  return out
}

// Minimal text extraction for Anthropic tool results, used by callsOf.
function blockTextOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? null, null, 2)
  return content.map((c) => c?.text ?? JSON.stringify(c)).join('\n')
}

function kindOf(rec) {
  if ((rec.provider ?? 'anthropic') !== 'anthropic') {
    // Codex runs one call per turn; there are no side jobs to separate.
    return viewOf(rec).tools.length > 0 ? 'session' : 'other'
  }
  const s = rec.request?.system
  const sys = typeof s === 'string' ? s : (s || []).map((b) => b?.text || '').join('\n')
  const tools = rec.request?.tools?.length ?? 0
  if (/Generate a concise, sentence-case title/i.test(sys)) return 'title'
  if (/kicked off a Claude Code agent|decide which of four states/i.test(sys)) return 'state'
  if (/summar/i.test(sys) && tools === 0) return 'summary'
  if (tools > 20) return 'session'
  return 'other'
}

// A human name for a session, derived on read. Claude runs a background
// call whose reply becomes the thread title in the app; when a session has
// one, that reply is the honest name. Otherwise the first thing the user
// typed serves. Harness text rides inside user messages, so skip it.
const HARNESS_PREFIXES = [
  '<system-reminder>',
  '<task-notification>',
  '<INSTRUCTIONS>',
  '<environment_context>',
  '<user_instructions>',
  '<turn_context>',
  '<recommended_plugins>',
  '<permissions',
  '# AGENTS.md instructions',
]

function titleOf(recs) {
  for (const rec of recs) {
    if (kindOf(rec) !== 'title') continue
    const t = (rec.response?.text || '').trim().replace(/^"|"$/g, '')
    if (t) return t.split('\n')[0].slice(0, 80)
  }
  for (const rec of recs) {
    for (const m of viewOf(rec).messages) {
      if (m.role !== 'user') continue
      const text = (
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => (c?.type === 'text' ? (c.text ?? '') : '')).join('\n')
            : ''
      ).trim()
      if (!text || HARNESS_PREFIXES.some((p) => text.startsWith(p))) continue
      return text.replace(/\s+/g, ' ').slice(0, 80)
    }
  }
  return null
}

function summarise(rec) {
  const u = rec.response?.usage || {}
  const view = viewOf(rec)
  return {
    id: rec.id,
    seq: rec.seq,
    ts: rec.ts,
    provider: rec.provider ?? 'anthropic',
    kind: kindOf(rec),
    model: rec.model,
    url: rec.url,
    status: rec.response?.status,
    took_ms: rec.took_ms,
    ttfb_ms: rec.ttfb_ms,
    stop_reason: rec.response?.stop_reason,
    tools: view.tools.length,
    messages: view.messages.length,
    usage: {
      input: u.input_tokens ?? null,
      output: u.output_tokens ?? null,
      cache_write: u.cache_creation_input_tokens ?? null,
      cache_read: u.cache_read_input_tokens ?? null,
    },
    tool_calls: (rec.response?.tool_calls || []).map((t) => t.name),
  }
}

async function viewer(req, res, url) {
  const rest = url.pathname.slice('/__wire'.length) || '/'

  if (!rest.startsWith('/api/')) return serveStatic(res, rest)

  if (rest === '/api/sessions' && req.method !== 'DELETE') {
    const files = (await fsp.readdir(DATA_DIR)).filter((f) => f.endsWith('.ndjson'))
    const out = []
    for (const f of files) {
      const st = await fsp.stat(path.join(DATA_DIR, f))
      const recs = await readSession(f).catch(() => [])
      const first = recs[0]
      out.push({
        file: f,
        calls: recs.length,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        started: first?.ts ?? null,
        provider: first?.provider ?? 'anthropic',
        model: recs.at(-1)?.model ?? null,
        title: titleOf(recs),
      })
    }
    out.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return json(res, out)
  }

  // Where the records live on disk, so the viewer can hand a session file
  // to an agent. A path, not a payload: nothing is read here.
  if (rest === '/api/info') {
    return json(res, { dir: DATA_DIR })
  }

  if (rest === '/api/sessions' && req.method === 'DELETE') {
    const files = (await fsp.readdir(DATA_DIR)).filter((f) => f.endsWith('.ndjson'))
    for (const f of files) await fsp.rm(path.join(DATA_DIR, f), { force: true })
    openFiles.clear()
    return json(res, { deleted: files.length })
  }

  let m = rest.match(/^\/api\/session\/(.+)$/)
  if (m && req.method === 'DELETE') {
    const name = safeName(decodeURIComponent(m[1]))
    if (!name) return json(res, { error: 'bad name' }, 400)
    const full = path.join(DATA_DIR, name)
    if (!full.startsWith(DATA_DIR)) return json(res, { error: 'bad name' }, 400)
    await fsp.rm(full, { force: true })
    openFiles.delete(full)
    return json(res, { deleted: 1 })
  }
  if (m) {
    const name = safeName(decodeURIComponent(m[1]))
    if (!name) return json(res, { error: 'bad name' }, 400)
    const recs = await readSession(name).catch(() => null)
    if (!recs) return json(res, { error: 'not found' }, 404)
    return json(res, recs.map(summarise))
  }

  m = rest.match(/^\/api\/call\/([^/]+)\/(\d+)$/)
  if (m) {
    const name = safeName(decodeURIComponent(m[1]))
    if (!name) return json(res, { error: 'bad name' }, 400)
    const recs = await readSession(name).catch(() => null)
    if (!recs) return json(res, { error: 'not found' }, 404)
    const i = Number(m[2])
    const rec = recs.find((r) => r.seq === i) || recs[i]
    if (!rec) return json(res, { error: 'no such call' }, 404)
    const earlier = recs.filter((r) => r.seq < rec.seq)
    // A session mixes the conversation with background jobs. Comparing a
    // conversation turn against a title generator marks everything as new, so
    // the diff uses the previous call doing the same job.
    const kind = kindOf(rec)
    const prev = earlier.at(-1) || null
    const comparable = earlier.filter((r) => kindOf(r) === kind).at(-1) || null
    const withView = (r) => {
      if (!r) return null
      const v = viewOf(r)
      return { ...r, kind: kindOf(r), view: v, calls: callsOf(r, v) }
    }
    const view = viewOf(rec)
    return json(res, {
      call: { ...rec, kind, view, calls: callsOf(rec, view) },
      prev: withView(prev),
      comparable: withView(comparable),
    })
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
}

const DIST = path.join(HERE, 'viewer', 'dist')

// The viewer is a built single-page app. Any path that is not an asset falls
// back to index.html.
function serveStatic(res, rest) {
  const rel = rest === '/' ? 'index.html' : rest.replace(/^\/+/, '')
  const file = path.join(DIST, rel)
  if (!file.startsWith(DIST)) {
    res.writeHead(400)
    return res.end('bad path')
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (rel === 'index.html') {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('The viewer is not built yet. Run: cd ui && npm run build')
      }
      return serveStatic(res, '/')
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}

// ------------------------------------------------------------------- start

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/__wire' || url.pathname.startsWith('/__wire/')) {
    return viewer(req, res, url).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(err))
    })
  }
  // Convenience for a human who opens the port in a browser. No API client
  // does a bare GET on the root or asks this host for a favicon.
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(302, { location: '/__wire/' })
    return res.end()
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204)
    return res.end()
  }
  proxy(req, res)
})

server.headersTimeout = 0
server.requestTimeout = 0
server.timeout = 0
server.keepAliveTimeout = 60_000

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `agent-tap\n` +
      `  proxy    http://${HOST}:${PORT}  ->  ${UPSTREAM.origin}\n` +
      `  viewer   http://${HOST}:${PORT}/__wire/\n` +
      `  storage  ${DATA_DIR}\n\n` +
      `  run:  ANTHROPIC_BASE_URL=http://${HOST}:${PORT} claude\n\n`
  )
})
