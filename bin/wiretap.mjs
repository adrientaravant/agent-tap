#!/usr/bin/env node
// wiretap — switch the capture proxy on and off.
//
//   wiretap on      start the proxy and route new terminal sessions through it
//   wiretap off     stop the proxy and restore direct calls
//   wiretap status  report the current state
//   wiretap open    open the viewer
//   wiretap tail    follow the proxy log
//
// "on" writes ANTHROPIC_BASE_URL into ~/.claude/settings.json. Only sessions
// started after the switch are affected, and only sessions started from a
// terminal: the desktop app overrides the host for the sessions it spawns.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'server.mjs')
const PORT = Number(process.env.WIRETAP_PORT || 8317)
const HOST = process.env.WIRETAP_HOST || '127.0.0.1'
const URL_ = `http://${HOST}:${PORT}`
const DATA = process.env.WIRETAP_DIR || path.join(os.homedir(), '.local/share/agent-tap')
const PID = path.join(DATA, 'server.pid')
const LOG = path.join(DATA, 'server.log')
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml')
const CODEX_MARK = '# --- agent-tap (managed) ---'
const CODEX_END = '# --- end agent-tap ---'

const c = {
  on: (s) => `\x1b[32m${s}\x1b[0m`,
  off: (s) => `\x1b[90m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
}
const say = (s = '') => process.stdout.write(s + '\n')

fs.mkdirSync(DATA, { recursive: true })

// ------------------------------------------------------------------ server

function livePid() {
  if (!fs.existsSync(PID)) return null
  const pid = Number(fs.readFileSync(PID, 'utf8').trim())
  if (!pid) return null
  try {
    process.kill(pid, 0) // signal 0 only tests that the process exists
    return pid
  } catch {
    fs.rmSync(PID, { force: true })
    return null
  }
}

function reachable(timeout = 800) {
  return new Promise((resolve) => {
    // /api/info answers from memory. The sessions listing parses every
    // record file and can take longer than this whole probe.
    const req = http.get({ host: HOST, port: PORT, path: '/__wire/api/info', timeout }, (res) => {
      res.resume()
      // An older server has no /api/info and answers 404 — still alive.
      resolve(res.statusCode === 200 || res.statusCode === 404)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function startServer() {
  if (await reachable()) {
    if (livePid()) return 'already running'
    throw new Error(`port ${PORT} is taken by another process`)
  }
  const out = fs.openSync(LOG, 'a')
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
  fs.writeFileSync(PID, String(child.pid))
  for (let i = 0; i < 50; i++) {
    if (await reachable(300)) return 'started'
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`the proxy did not answer within 5s — see ${LOG}`)
}

function stopServer() {
  const pid = livePid()
  if (!pid) return 'not running'
  process.kill(pid, 'SIGTERM')
  fs.rmSync(PID, { force: true })
  return 'stopped'
}

// ------------------------------------------------------------------- codex

// Codex takes a provider from config.toml. The block is written between two
// markers so removing it is exact, and the previous model_provider is kept on
// the same line so "off" restores it.
function codexBlock(previous) {
  return [
    CODEX_MARK,
    `# previous model_provider = ${previous ? JSON.stringify(previous) : 'none'}`,
    'model_provider = "wiretap"',
    '',
    '[model_providers.wiretap]',
    'name = "wiretap"',
    `base_url = "${URL_}/codex"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    CODEX_END,
    '',
  ].join('\n')
}

function codexOn() {
  if (!fs.existsSync(CODEX_CONFIG)) return 'no codex config'
  const raw = fs.readFileSync(CODEX_CONFIG, 'utf8')
  if (raw.includes(CODEX_MARK)) return 'already routed'
  const current = raw.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null
  fs.copyFileSync(CODEX_CONFIG, CODEX_CONFIG + '.bak')
  // Comment out any existing setting so ours is the only one.
  const body = raw.replace(/^model_provider\s*=.*$/m, (line) => '# ' + line + '  # agent-tap')
  fs.writeFileSync(CODEX_CONFIG, codexBlock(current) + '\n' + body)
  return 'routed'
}

function codexOff() {
  if (!fs.existsSync(CODEX_CONFIG)) return 'no codex config'
  const raw = fs.readFileSync(CODEX_CONFIG, 'utf8')
  if (!raw.includes(CODEX_MARK)) return 'not routed'
  fs.copyFileSync(CODEX_CONFIG, CODEX_CONFIG + '.bak')
  // Cut between the markers by index. They contain "(managed)", and a regex
  // built from that string would read the parentheses as a group and match
  // nothing — which silently left the block in place.
  let cleaned = raw
  for (;;) {
    const start = cleaned.indexOf(CODEX_MARK)
    if (start === -1) break
    const end = cleaned.indexOf(CODEX_END, start)
    if (end === -1) break
    let stop = end + CODEX_END.length
    if (cleaned[stop] === '\n') stop++
    cleaned = cleaned.slice(0, start) + cleaned.slice(stop)
  }
  cleaned = cleaned.replace(/^# (model_provider\s*=.*?)  # agent-tap$/m, '$1').replace(/^\n+/, '')
  fs.writeFileSync(CODEX_CONFIG, cleaned)
  return 'direct'
}

// Check the address too, not just the marker: another copy of wiretap on a
// different port would otherwise report this one as routed.
const codexRouted = () =>
  fs.existsSync(CODEX_CONFIG) &&
  fs.readFileSync(CODEX_CONFIG, 'utf8').includes(`base_url = "${URL_}/codex"`)

// ---------------------------------------------------------------- settings

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {}
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
}

function writeSettings(obj) {
  fs.copyFileSync(SETTINGS, SETTINGS + '.bak')
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n')
}

function routeOn() {
  const s = readSettings()
  const current = s.env?.ANTHROPIC_BASE_URL
  if (current === URL_) return 'already routed'
  if (current) throw new Error(`ANTHROPIC_BASE_URL is already set to ${current} — left untouched`)
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: URL_ }
  writeSettings(s)
  return 'routed'
}

function routeOff() {
  const s = readSettings()
  const current = s.env?.ANTHROPIC_BASE_URL
  if (!current) return 'not routed'
  if (current !== URL_) throw new Error(`ANTHROPIC_BASE_URL points at ${current}, not at me — left untouched`)
  delete s.env.ANTHROPIC_BASE_URL
  if (!Object.keys(s.env).length) delete s.env
  writeSettings(s)
  return 'direct'
}

const routed = () => readSettings().env?.ANTHROPIC_BASE_URL === URL_

// The desktop app cannot be captured. Measured on 2026-08-17: the app process
// itself inherits the GUI variable, but it overrides ANTHROPIC_BASE_URL with
// https://api.anthropic.com for every session it spawns. Setting the variable
// at any level therefore changes nothing. guiOff stays only to clear the
// variable set by earlier versions of this script.
function guiEnv() {
  try {
    return execFileSync('launchctl', ['getenv', 'ANTHROPIC_BASE_URL'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function guiOff() {
  const current = guiEnv()
  if (!current) return 'not set'
  if (current !== URL_) throw new Error(`the GUI variable points at ${current} — left untouched`)
  execFileSync('launchctl', ['unsetenv', 'ANTHROPIC_BASE_URL'])
  return 'cleared'
}

// -------------------------------------------------------------------- main

const sessions = () =>
  fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => f.endsWith('.ndjson')) : []

async function status() {
  const up = await reachable()
  const pid = livePid()
  say()
  say(`  proxy     ${up ? c.on('running') + c.off(pid ? ` (pid ${pid})` : '') : c.off('stopped')}`)
  say(`  claude    ${routed() ? c.on('on') + c.off('  new terminal sessions are captured') : c.off('off')}`)
  say(`  codex     ${codexRouted() ? c.on('on') + c.off('  new codex sessions are captured') : c.off('off')}`)
  say(`  desktop   ${c.off('not possible')}${c.off('  the Claude app pins the API host')}`)
  say(`  captured  ${sessions().length} sessions in ${DATA}`)
  say(`  viewer    ${URL_}/__wire/`)
  if ((routed() || codexRouted() || guiEnv() === URL_) && !up) {
    say()
    say(c.bad('  routing is on but the proxy is down — new sessions will fail.'))
    say(c.bad('  run: wiretap on   (or: wiretap off)'))
  }
  say()
}

const cmd = process.argv[2] || 'status'

try {
  if (cmd === 'on') {
    say(`  proxy     ${await startServer()}`)
    say(`  claude    ${routeOn()}`)
    say(`  codex     ${codexOn()}`)
    say()
    say(c.warn('  Start a new claude or codex session in a terminal to capture it.'))
    say(c.off('  Sessions already open keep their old setting.'))
    say(c.off('  The desktop app cannot be captured: it overrides the host for'))
    say(c.off('  every session it starts.'))
    say(c.off(`  Viewer: ${URL_}/__wire/`))
    say(c.off('  Turn it off with: wiretap off'))
    say()
  } else if (cmd === 'off') {
    say(`  claude    ${routeOff()}`)
    say(`  codex     ${codexOff()}`)
    say(`  cleanup   ${guiOff()}`)
    say(`  proxy     ${stopServer()}`)
    say()
    say(c.off('  Records are kept. New sessions call the API directly.'))
    say()
  } else if (cmd === 'status') {
    await status()
  } else if (cmd === 'clear') {
    const files = sessions()
    for (const f of files) fs.rmSync(path.join(DATA, f), { force: true })
    say(`  cleared   ${files.length} sessions`)
    say(c.off('  The proxy and the routing are untouched.'))
    say()
  } else if (cmd === 'open') {
    execFileSync('open', [`${URL_}/__wire/`])
  } else if (cmd === 'tail') {
    spawn('tail', ['-f', LOG], { stdio: 'inherit' })
  } else {
    say('usage: wiretap [on|off|status|clear|open|tail]')
    process.exit(1)
  }
} catch (err) {
  say(c.bad('  ' + err.message))
  process.exit(1)
}
