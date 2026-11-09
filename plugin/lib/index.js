/**
 * dsh-feishu-shot — answer Feishu "截图 / 截左屏 / 截右屏" in about a second.
 *
 * The Superagent Feishu Source already holds a live event consumer, and every message it receives is written to
 * `<stateDir>/orchestrator.sqlite` (table `trigger`) before any model work starts. Reading that table read-only costs a
 * few hundred microseconds and no API call, so a capture command never has to take the ticket path: this plugin polls
 * the newest triggers, matches the short capture commands, grabs the requested monitor with one resident PowerShell
 * worker, and sends the image back through the bot's lark-cli.
 *
 * The plugin never writes into the Superagent database: the handle is opened read-only, and the only files it owns are
 * `screenshots/` and `feishu-shot.log` next to it.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-feishu-shot'

const WORKER_SCRIPT = fileURLToPath(new URL('../scripts/shot-worker.ps1', import.meta.url))
const SEEN_LIMIT = 400

/** Removes mentions, whitespace and punctuation so "截图。" and "@机器人 截左屏" compare like the bare command. */
const MENTION = /[@＠][^\s@＠:：,，]{1,40}/g
const NOISE = /[\s\u3000，。、！？,.!?~～"'“”‘’（）()\[\]【】:：;；<>《》\-—_/\\|]+/g

export function normalizeCommand(text) {
  return String(text ?? '').replace(MENTION, '').replace(NOISE, '').toLowerCase()
}

/**
 * Returns the monitor a message asks for, or undefined when it is not a capture command.
 *
 * Only a message that is essentially the command matches: a sentence that merely mentions a screenshot still reaches
 * the normal agent path, and a polite wrapper such as 帮我…吧 is stripped first.
 */
export function shotCommand(text) {
  const command = normalizeCommand(text)
  if (!command || command.length > 12) return undefined
  const bare = core(command)
  if (/^(截图|截屏|屏幕截图|全屏|整屏|整个屏幕|screenshot|screencap|fullscreen)$/.test(bare)) return 'all'
  if (/^(截)?(左|右)(屏|屏幕|边|侧)?(截图|截屏)?$/.test(bare)) return /左/.test(bare) ? 'left' : 'right'
  return undefined
}

const HEAD = /^(请|麻烦|帮我一下|帮我|帮忙|给我|来|快点|快|马上|立刻|现在就|现在|就|再)+/
const TAIL = /(一下|吧|啊|呀|哦|谢谢|了|给我)+$/

/** Strips polite padding around a candidate command: 帮我截个图吧 → 截图. */
function core(command) {
  let value = command
  for (let round = 0; round < 4; round += 1) {
    const before = value
    value = value.replace(HEAD, '').replace(TAIL, '').replace(/个(?=[图屏])/g, '')
    if (value === before) break
  }
  return value
}

const firstExisting = candidates => candidates.find(candidate => candidate && existsSync(candidate))

function resolveSettings(config = {}) {
  const home = process.env.USERPROFILE || homedir()
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const stateDir = String(config.stateDir ?? join(home, '.dsh', 'state', 'superagent'))
  const cli = String(config.cli
    ?? process.env.DSH_FEISHU_SHOT_CLI
    ?? firstExisting([join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe')])
    ?? 'lark-cli')
  const powershell = String(config.powershell
    ?? firstExisting([join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), 'pwsh.exe'])
    ?? 'powershell.exe')
  const shotsDir = String(config.shotsDir ?? join(stateDir, 'screenshots'))
  return {
    stateDir,
    cli,
    powershell,
    shotsDir,
    database: join(stateDir, 'orchestrator.sqlite'),
    intervalMs: Math.max(100, Number(config.intervalMs) || 250),
    allowedSenders: Array.isArray(config.allowedSenders) ? config.allowedSenders.map(String) : [],
    keepDays: Math.max(1, Number(config.keepDays) || 2),
  }
}

/** One resident PowerShell process; captures are serialized because a person never needs two at once. */
class ShotWorker {
  constructor(settings) {
    this.settings = settings
    this.child = null
    this.pending = null
    this.buffer = ''
    this.queue = Promise.resolve()
  }

  capture(target, file) {
    const run = () => this.request(target, file)
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  request(target, file) {
    return new Promise(resolve => {
      let child
      try {
        child = this.ensure()
      } catch (error) {
        resolve({ ok: false, error: String(error) })
        return
      }
      const timer = setTimeout(() => {
        this.pending = null
        this.child?.kill()
        this.child = null
        resolve({ ok: false, error: 'capture timed out after 15 s' })
      }, 15_000)
      this.pending = { resolve, timer }
      child.stdin.write(`${target}|${file}\n`)
    })
  }

  ensure() {
    if (this.child && this.child.exitCode === null) return this.child
    const child = spawn(this.settings.powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => this.onData(chunk))
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    child.on('exit', () => {
      this.child = null
      const pending = this.pending
      this.pending = null
      if (pending) {
        clearTimeout(pending.timer)
        pending.resolve({ ok: false, error: 'the capture worker exited' })
      }
    })
    this.child = child
    return child
  }

  onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let value
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (value.ready) continue
      const pending = this.pending
      if (!pending) continue
      this.pending = null
      clearTimeout(pending.timer)
      pending.resolve(value)
    }
  }

  stop() {
    this.child?.kill()
    this.child = null
  }
}

function run(command, args, cwd) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
    } catch (error) {
      resolve({ ok: false, error: String(error) })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'lark-cli timed out after 25 s' })
    }, 25_000)
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { err += data })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(error) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(out)
        resolve({ ok: parsed.ok !== false, data: parsed.data, error: parsed.error?.message ?? (parsed.ok === false ? err.trim() : undefined) })
      } catch {
        resolve({ ok: false, error: (err || out).trim().slice(0, 300) || 'lark-cli printed nothing' })
      }
    })
  })
}

class ShotService {
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    this.worker = new ShotWorker(settings)
    this.timer = undefined
    this.busy = false
    this.primed = false
    this.database = undefined
    this.seen = []
    this.flushedAt = 0
    this.logFile = join(settings.stateDir, 'feishu-shot.log')
    this.stateFile = join(settings.shotsDir, 'seen.json')
  }

  log(message) {
    try {
      appendFileSync(this.logFile, `[${new Date().toISOString()}] ${message}\n`)
    } catch { /* Diagnostics must never break a capture. */ }
  }

  start() {
    mkdirSync(this.settings.shotsDir, { recursive: true })
    try {
      const stored = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (Array.isArray(stored?.seen)) this.seen = stored.seen.map(String)
    } catch { /* A first run has nothing to restore. */ }
    this.primed = this.seen.length > 0
    this.timer = setInterval(() => { void this.tick() }, this.settings.intervalMs)
    this.timer.unref?.()
    void this.tick()
    this.log(`watching ${this.settings.database} every ${this.settings.intervalMs} ms with ${this.settings.cli}`)
    this.ctx.logger?.info?.('dsh-feishu-shot is watching %s', this.settings.database)
    return () => this.stop()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.worker.stop()
    try {
      this.database?.close?.()
    } catch { /* Closing a read-only handle is best effort. */ }
    this.database = undefined
  }

  async open() {
    const sqlite = process.getBuiltinModule?.('node:sqlite') ?? await import('node:sqlite')
    const database = new sqlite.DatabaseSync(this.settings.database, { readOnly: true })
    database.prepare('select id from trigger limit 1').all()
    return database
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      if (!this.database) {
        try {
          this.database = await this.open()
        } catch (error) {
          this.log(`cannot read the trigger store yet: ${String(error)}`)
          return
        }
      }
      const rows = this.database.prepare('select id, value from trigger order by at desc, rowid desc limit 8').all()
      const fresh = rows.filter(row => !this.seen.includes(String(row.id)))
      for (const row of rows) this.remember(String(row.id))
      // The first run adopts whatever is already stored, so history is never replayed.
      if (!this.primed) {
        this.primed = true
        if (fresh.length) this.log(`adopted ${fresh.length} trigger(s) already present`)
        this.persist(true)
        return
      }
      for (const row of fresh.reverse()) this.offer(row)
      this.persist(false)
    } finally {
      this.busy = false
    }
  }

  remember(id) {
    if (this.seen.includes(id)) return
    this.seen.push(id)
    if (this.seen.length > SEEN_LIMIT) this.seen = this.seen.slice(-SEEN_LIMIT)
  }

  persist(force) {
    const now = Date.now()
    if (!force && now - this.flushedAt < 2_000) return
    this.flushedAt = now
    try {
      writeFileSync(this.stateFile, JSON.stringify({ seen: this.seen }))
    } catch (error) {
      this.log(`cannot persist the seen list: ${String(error)}`)
    }
  }

  offer(row) {
    let trigger
    try {
      trigger = JSON.parse(String(row.value))
    } catch {
      return
    }
    if (trigger?.source !== 'feishu') return
    const target = shotCommand(trigger.text)
    if (!target) return
    const chatId = String(trigger.meta?.chatId ?? '')
    if (!chatId) return
    const sender = String(trigger.actor?.id ?? '')
    if (this.settings.allowedSenders.length && !this.settings.allowedSenders.includes(sender)) {
      this.log(`ignored ${target} from an unlisted sender ${sender}`)
      return
    }
    void this.serve(trigger, target, chatId)
  }

  async serve(trigger, target, chatId) {
    const started = Date.now()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(this.settings.shotsDir, `${stamp}-${target}.jpg`)
    try {
      const shot = await this.worker.capture(target, file)
      if (!shot.ok) throw new Error(shot.error ?? 'the capture worker failed')
      const sent = await this.send(chatId, ['--image', basename(file)])
      if (!sent.ok) throw new Error(sent.error ?? 'lark-cli refused the image')
      this.log(`sent ${target} ${shot.width}x${shot.height} (${shot.ms} ms capture) to ${chatId} in ${Date.now() - started} ms`)
      this.ctx.logger?.info?.('dsh-feishu-shot sent %s to %s in %d ms', target, chatId, Date.now() - started)
    } catch (error) {
      this.log(`failed ${target} for ${chatId}: ${String(error)}`)
      await this.send(chatId, ['--text', `截图失败：${String(error).slice(0, 180)}`]).catch(() => {})
    } finally {
      this.prune()
    }
  }

  send(chatId, content) {
    return run(this.settings.cli,
      ['im', '+messages-send', '--chat-id', chatId, ...content, '--as', 'bot', '--format', 'json'], this.settings.shotsDir)
  }

  prune() {
    try {
      const cutoff = Date.now() - this.settings.keepDays * 86_400_000
      for (const entry of readdirSync(this.settings.shotsDir)) {
        if (!entry.endsWith('.jpg')) continue
        const path = join(this.settings.shotsDir, entry)
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      }
    } catch { /* Pruning is housekeeping only. */ }
  }
}

export function apply(ctx, config) {
  const settings = resolveSettings(config ?? {})
  ctx.effect(() => new ShotService(ctx, settings).start())
}
