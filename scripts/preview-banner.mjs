#!/usr/bin/env node
/**
 * 横幅预览 —— **拿真实 profile 的数据，把页面横幅真渲染一遍给你看**。
 *
 * 为什么需要它：`lib/client.js` 平时跑在浏览器里，"它到底会显示什么"很难在动手前确认。
 * 这个脚本用 `auditProfileProbed()`（和宿主页面接口**同一条**数据链路）算出报文，
 * 再把报文喂给**真正的 client.js**（环境是 scripts/helpers/fake-dom.mjs 那套假 DOM），
 * 最后把横幅的 HTML 与可见文本打印出来。
 *
 * 它**只读**：不装不卸、不改 profile、不发任何修复请求（POST 会被本脚本的 fetch 桩直接挡掉）。
 *
 * 用法：
 *   node scripts/preview-banner.mjs                # 看真实环境会弹什么
 *   node scripts/preview-banner.mjs --profile web  # 指定 profile
 *   node scripts/preview-banner.mjs --press 1      # 顺便演示"按 1"会发出什么请求
 *   node scripts/preview-banner.mjs --html         # 打印渲染后的 HTML
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { auditProfileProbed } from '../lib/audit.js'
import { statusPayload } from '../lib/routes.js'
import { resolveContext } from '../lib/adapt.js'
import { makeDom, loadClient, keyEvent, clickTarget, flush } from './helpers/fake-dom.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = { profile: undefined, home: undefined, press: undefined, html: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') { out.profile = argv[i + 1]; i += 1 }
    if (argv[i] === '--home') { out.home = argv[i + 1]; i += 1 }
    if (argv[i] === '--press') { out.press = argv[i + 1]; i += 1 }
    if (argv[i] === '--html') out.html = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const context = resolveContext({ profileName: args.profile, home: args.home })
const targets = {
  profileDir: context.profileDir,
  profileName: context.profileName,
  installAnchor: context.installAnchor,
  home: context.home,
}

console.log('='.repeat(78))
console.log('横幅预览（只读：不改 profile、不发修复请求）')
console.log(`profile      : ${targets.profileName}`)
console.log(`profile 目录 : ${targets.profileDir}`)
console.log(`dsh 安装     : ${targets.installAnchor ?? '（没定位到）'}`)
console.log('='.repeat(78))

if (!targets.profileDir || !fs.existsSync(targets.profileDir)) {
  console.log('找不到 profile 目录，没什么可预览的。')
  process.exit(0)
}

// 与宿主页面接口同一条数据链路（auditProfileProbed + statusPayload）
const report = await auditProfileProbed(targets)
const payload = statusPayload({ report, profileName: targets.profileName, canRepair: true })

console.log('\n---- 页面接口会给浏览器的数据（摘要）----')
console.log(`dshVersion = ${payload.dshVersion}   profile = ${payload.profile}`)
console.log(`summary    = ${JSON.stringify(payload.summary)}`)
console.log(`阻断类问题 = ${payload.problems.length} 条；快要不适配 = ${payload.upcoming.length} 条；可修复 = ${payload.canRepair}`)
for (const one of payload.problems) {
  console.log(`   · ${one.name}@${one.version}  [${one.severity}]  ${one.title}`)
  console.log(`     动作 ${one.actions.join('/')}（默认 ${one.defaultAction}）`)
}
for (const one of payload.upcoming) {
  console.log(`   · [预测] ${one.name}@${one.version}  ${one.levelText}  —— ${one.reason}`)
}

// ---- 把真报文喂给真 client.js ----
const requests = []
const fetchImpl = (url, options = {}) => {
  const method = options.method ?? 'GET'
  requests.push({ method, url, body: options.body })
  if (url.includes('/status')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
  }
  if (method === 'POST') {
    // **刻意不真修**：这个脚本只做展示，收到 POST 就明确挡掉
    console.log(`\n[被预览脚本拦下的修复请求] ${method} ${url}  body=${options.body}`)
    return Promise.reject(new Error('preview only：预览脚本不执行任何修复'))
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, job: null }) })
}

const dom = makeDom()
const client = await loadClient({ dom, fetchImpl })
client.apply()
await flush()
await flush()

const banner = dom.document.getElementById('dsh-compat-doctor-banner')
console.log(`\n${'='.repeat(78)}\n浏览器里会看到的横幅\n${'='.repeat(78)}`)
if (banner === null) {
  console.log('（没有问题，所以**不挂横幅** —— 这是刻意的：没毛病就别打扰用户）')
} else {
  console.log(`class = ${banner.className || '(无)'}`)
  console.log(`\n可见文本：\n${banner.textContent.split('\n').map((line) => `  ${line}`).join('\n')}`)
  const bindings = client.__test.state.bindings
  const keys = Object.keys(bindings).sort()
  console.log(`\n按键绑定：${keys.map((key) => `[${key}] ${bindings[key]}`).join('   ')}`)
  if (args.html) console.log(`\nHTML：\n${banner.innerHTML}`)
}

// ---- 可选：演示按键会发出什么请求 ----
if (args.press !== undefined) {
  const before = requests.length
  console.log(`\n${'='.repeat(78)}\n演示：按下「${args.press}」\n${'='.repeat(78)}`)
  dom.document.fire('keydown', keyEvent(args.press))
  await flush()
  const newOnes = requests.slice(before)
  if (newOnes.length === 0) console.log('（没有发出任何请求）')
  for (const one of newOnes) console.log(`  → ${one.method} ${one.url}${one.body ? `  body=${one.body}` : ''}`)
  const after = dom.document.getElementById('dsh-compat-doctor-banner')
  const flash = client.__test.state.flash
  if (flash) console.log(`  横幅结果态：${flash.ok ? '成功' : '失败'} —— ${flash.text}`)
  else if (after !== null) console.log(`  横幅仍在（等待后端作业）：${after.textContent.split('\n')[0]}`)
}

console.log('')
