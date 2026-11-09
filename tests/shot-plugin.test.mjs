/**
 * Offline checks for the dsh-feishu-shot plugin: command parsing, and a real capture through the resident worker.
 * Run with: node --test tests/
 */
import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shotCommand, normalizeCommand } from '../plugin/lib/index.js'

test('capture commands match only short requests', () => {
  assert.equal(shotCommand('截图'), 'all')
  assert.equal(shotCommand('截屏'), 'all')
  assert.equal(shotCommand('截个图'), 'all')
  assert.equal(shotCommand('全屏'), 'all')
  assert.equal(shotCommand('截左屏'), 'left')
  assert.equal(shotCommand('截右屏'), 'right')
  assert.equal(shotCommand('左屏'), 'left')
  assert.equal(shotCommand('右边截个图'), 'right')
  assert.equal(shotCommand('@龙广超级助手 截左屏'), 'left')
  assert.equal(shotCommand('截左屏。'), 'left')
  assert.equal(shotCommand('帮我截个图'), 'all')
  assert.equal(shotCommand('screenshot'), 'all')
  assert.equal(shotCommand('  '), undefined)
  assert.equal(shotCommand('二维码截图后发我一下，顺便看看登录状态是否正常'), undefined)
  assert.equal(shotCommand('不要在截图里显示密码'), undefined)
  assert.equal(normalizeCommand('@龙广超级助手 截 左 屏'), '截左屏')
})

test('the resident worker captures the requested monitor', async () => {
  const dir = join(process.env.TEMP ?? '.', 'shot-plugin-test')
  mkdirSync(dir, { recursive: true })
  const worker = spawn(process.env.DSH_SHOT_PWSH ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', new URL('../plugin/scripts/shot-worker.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
    { stdio: ['pipe', 'pipe', 'pipe'] })
  worker.stdout.setEncoding('utf8')
  const results = []
  let buffer = ''
  const waiters = []
  worker.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const value = JSON.parse(line)
      if (value.ready) continue
      results.push(value)
      waiters.shift()?.()
    }
  })
  const next = () => results.length ? Promise.resolve(results.shift()) : new Promise(resolve => waiters.push(() => resolve(results.shift())))
  const run = async target => {
    const file = join(dir, `${target}.jpg`)
    worker.stdin.write(`${target}|${file}\n`)
    const result = await next()
    assert.equal(result.ok, true, result.error)
    assert.ok(statSync(file).size > 10_000, 'the capture should not be an empty image')
    return result
  }
  const left = await run('left')
  const right = await run('right')
  const all = await run('all')
  assert.ok(all.width >= left.width + right.width - 1, 'the full desktop should span at least both monitors')
  assert.ok(left.left <= 0 && right.left >= left.left + left.width - 1, 'left must be the leftmost monitor and right the rightmost')
  worker.kill()
})
