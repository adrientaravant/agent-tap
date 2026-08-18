// End-to-end test with a fake upstream. No network, no dependency.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'server.mjs')
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wiretap-test-'))

let upstream, proxy, upstreamPort, proxyPort

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
}

// The fake API: a slow SSE stream, plus a plain JSON route.
async function startUpstream() {
  upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      if (req.url === '/v1/messages' && JSON.parse(body).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
        send({
          type: 'message_start',
          message: { model: 'claude-opus-5', usage: { input_tokens: 11, cache_read_input_tokens: 900 } },
        })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for (const piece of ['he', 'llo']) {
          await new Promise((r) => setTimeout(r, 120))
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
        }
        send({ type: 'content_block_stop', index: 0 })
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 3 },
          content: [{ type: 'text', text: 'ok' }],
          auth_ok: req.headers.authorization === 'Bearer sk-ant-secret-value',
          key_ok: req.headers['x-api-key'] === 'sk-ant-another-secret',
        })
      )
    })
  })
  upstreamPort = await listen(upstream)
}

function startProxy() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(() => {})
    srv.listen(0, '127.0.0.1', () => {
      proxyPort = srv.address().port
      srv.close(() => {
        proxy = spawn(process.execPath, [SERVER], {
          env: {
            ...process.env,
            WIRETAP_PORT: String(proxyPort),
            WIRETAP_DIR: DATA,
            WIRETAP_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proxy.stdout.on('data', (d) => {
          if (String(d).includes('viewer')) resolve()
        })
        proxy.stderr.on('data', (d) => process.stderr.write('[proxy] ' + d))
        proxy.on('exit', (c) => reject(new Error('proxy exited ' + c)))
      })
    })
  })
}

const body = (extra = {}) => ({
  model: 'claude-opus-5',
  max_tokens: 64,
  metadata: { user_id: 'user_abc_account_def_session_11111111-2222-3333-4444-555555555555' },
  system: [{ type: 'text', text: 'You are a test.', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

function post(pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw),
          authorization: 'Bearer sk-ant-secret-value',
          'x-api-key': 'sk-ant-another-secret',
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        const times = []
        res.on('data', (c) => {
          chunks.push(c)
          times.push(Date.now())
        })
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), times })
        )
      }
    )
    req.on('error', reject)
    req.end(raw)
  })
}

const del = (p) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path: p, method: 'DELETE' },
      (res) => {
        const c = []
        res.on('data', (x) => c.push(x))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }))
      }
    )
    req.on('error', reject)
    req.end()
  })

const get = (p) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: proxyPort, path: p }, (res) => {
        const c = []
        res.on('data', (x) => c.push(x))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }))
      })
      .on('error', reject)
  })

const logFiles = () => fs.readdirSync(DATA).filter((f) => f.endsWith('.ndjson'))
const records = () =>
  logFiles().flatMap((f) =>
    fs.readFileSync(path.join(DATA, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  )

// The record is appended after the reply closes, so the client can return
// before the line is on disk. Wait for it instead of sleeping a fixed time.
async function settled(n) {
  for (let i = 0; i < 200; i++) {
    if (records().length >= n) return records()
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`only ${records().length} records after waiting for ${n}`)
}

test.before(async () => {
  await startUpstream()
  await startProxy()
})
test.after(() => {
  proxy?.kill()
  upstream?.close()
  fs.rmSync(DATA, { recursive: true, force: true })
})

test('forwards a plain call and passes the reply through', async () => {
  const res = await post('/v1/messages', body())
  assert.equal(res.status, 200)
  const json = JSON.parse(res.text)
  assert.equal(json.content[0].text, 'ok')
  // The upstream must still receive the real credentials, unchanged.
  assert.equal(json.auth_ok, true)
  assert.equal(json.key_ok, true)
})

test('strips credentials from the file', async () => {
  const all = await settled(1)
  const raw = fs.readFileSync(path.join(DATA, logFiles()[0]), 'utf8')
  assert.ok(!raw.includes('sk-ant-secret-value'), 'authorization value leaked to disk')
  assert.ok(!raw.includes('sk-ant-another-secret'), 'x-api-key value leaked to disk')
  assert.match(all[0].request_headers.authorization, /^\[redacted/)
  assert.match(all[0].request_headers['x-api-key'], /^\[redacted/)
})

test('records the full request body', async () => {
  const rec = (await settled(1))[0]
  assert.equal(rec.request.system[0].text, 'You are a test.')
  assert.equal(rec.request.system[0].cache_control.type, 'ephemeral')
  assert.equal(rec.request.tools[0].name, 'Read')
  assert.equal(rec.request.messages.length, 1)
  assert.equal(rec.response.usage.input_tokens, 7)
})

test('groups by session id from metadata', async () => {
  await post('/v1/messages', body({ messages: [{ role: 'user', content: 'again' }] }))
  const all = await settled(2)
  const files = logFiles()
  assert.equal(files.length, 1, 'same session must stay in one file')
  assert.ok(files[0].includes('11111111-2222-3333-4444-555555555555'))
  assert.deepEqual(all.map((r) => r.seq), all.map((_, i) => i))
})

test('reads the session id from the JSON user_id Claude Code sends', async () => {
  const before = logFiles().length
  const uid = JSON.stringify({
    device_id: 'abc',
    account_uuid: 'bffd11e7-cbda-4647-86cf-d33c85655fc4',
    session_id: '2f4013b6-ce73-447f-a989-172dfc2bae9a',
  })
  // Two calls with different content must still land in one file.
  await post('/v1/messages', body({ metadata: { user_id: uid } }))
  await post('/v1/messages', body({ metadata: { user_id: uid }, messages: [{ role: 'user', content: 'second' }] }))
  await settled(4)
  const named = logFiles().filter((f) => f.includes('2f4013b6-ce73-447f-a989-172dfc2bae9a'))
  assert.equal(named.length, 1, 'the JSON session id must give one file')
  assert.equal(logFiles().length, before + 1, 'no anon fallback file')
  const lines = fs.readFileSync(path.join(DATA, named[0]), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('streams SSE through without buffering', async () => {
  const res = await post('/v1/messages', body({ stream: true }))
  assert.equal(res.status, 200)
  assert.ok(res.text.includes('"text":"he"'))
  // The two deltas are 120ms apart upstream. A buffered proxy would deliver
  // every chunk at the same instant.
  const span = res.times.at(-1) - res.times[0]
  assert.ok(span > 100, `reply arrived in one block (span ${span}ms)`)
})

test('reconstructs usage and text from the stream', async () => {
  const rec = (await settled(5)).find((r) => r.response?.streamed)
  assert.ok(rec, 'no streamed record found')
  assert.equal(rec.response.streamed, true)
  assert.equal(rec.response.text, 'hello')
  assert.equal(rec.response.stop_reason, 'end_turn')
  assert.equal(rec.response.usage.cache_read_input_tokens, 900)
  assert.equal(rec.response.usage.output_tokens, 5)
})

test('viewer API lists sessions and calls', async () => {
  const sessions = JSON.parse((await get('/__wire/api/sessions')).text)
  assert.equal(sessions.length, logFiles().length)
  const main = sessions.find((s) => s.file.includes('11111111-2222-3333-4444-555555555555'))
  assert.ok(main, 'the first session is not listed')
  const calls = JSON.parse((await get('/__wire/api/session/' + main.file)).text)
  assert.ok(calls.length >= 3)
  assert.equal(calls[0].model, 'claude-opus-5')
  const detail = JSON.parse((await get(`/__wire/api/call/${main.file}/1`)).text)
  assert.equal(detail.call.seq, 1)
  assert.equal(detail.prev.seq, 0)
})

test('viewer rejects a path outside the data directory', async () => {
  const res = await get('/__wire/api/session/' + encodeURIComponent('../../etc/passwd'))
  assert.equal(res.status, 400)
})

test('refuses to delete a path outside the data directory', async () => {
  const res = await del('/__wire/api/session/' + encodeURIComponent('../../etc/passwd'))
  assert.equal(res.status, 400)
})

test('deletes one session, then all of them', async () => {
  const before = logFiles()
  assert.ok(before.length >= 2, 'need more than one session for this test')
  const one = before[0]
  const res = await del('/__wire/api/session/' + encodeURIComponent(one))
  assert.equal(res.status, 200)
  assert.ok(!logFiles().includes(one), 'the file is still on disk')
  assert.equal(logFiles().length, before.length - 1)

  const all = await del('/__wire/api/sessions')
  assert.equal(all.status, 200)
  assert.equal(logFiles().length, 0)
  const listed = JSON.parse((await get('/__wire/api/sessions')).text)
  assert.equal(listed.length, 0)
})

test('serves the viewer page', async () => {
  const res = await get('/__wire/')
  assert.equal(res.status, 200)
  assert.ok(res.text.includes('agent-tap'))
})
