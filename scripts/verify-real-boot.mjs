#!/usr/bin/env node
/**
 * 真机启动验证 —— 在两个（或更多）**真实 dsh 版本**上各启动一次，
 * 证明 dsh-compat-vet 的 apply() 真的在 dsh 进程里跑起来了，
 * 而且告警措辞跟着那个 dsh 版本自己变。
 *
 * 为什么不能只靠单元测试：单元测试里 cordis 上下文是我捏的假货。
 * 「插件在真 dsh 启动流程里到底会不会被调用、输出长什么样」只能真启动一次才算数。
 *
 * 安全性（这是本脚本存在的意义之一 —— 它绝不碰用户的真实环境）：
 *   · 全程在一个临时 DSH_HOME 里跑；
 *   · profile 由 dsh 自带的 headless 模板现场初始化，最小化；
 *   · 不监听端口（headless 不联网服务）、不动 ~/.dsh、不影响正在运行的 Web GUI。
 *
 * 用法：
 *   node scripts/verify-real-boot.mjs                  # 自动找出本机所有 dsh 版本各跑一次
 *   node scripts/verify-real-boot.mjs --dsh <anchor>   # 只跑指定的 dsh
 *   node scripts/verify-real-boot.mjs --keep           # 保留临时目录，便于人工翻看
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { probeRuntime } from '../lib/adapt.js'
import { locateAnchor } from '../lib/locate.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const PROFILE_NAME = 'doctorcheck'

function parseArgs(argv) {
  const out = { keep: false, dsh: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') out.keep = true
    if (argv[i] === '--dsh') { out.dsh = argv[i + 1]; i += 1 }
  }
  return out
}

/** 本机所有真实可用的 dsh 安装（package.json 绝对路径）。 */
function discoverAnchors() {
  const found = new Set()
  const bases = []
  if (process.env.LOCALAPPDATA) bases.push(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  for (const base of bases) {
    let entries = []
    try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const anchor = path.join(base, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (fs.existsSync(anchor)) found.add(anchor)
    }
  }
  const located = locateAnchor()
  if (located && fs.existsSync(located)) found.add(located)
  return [...found]
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function linkDir(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  if (fs.existsSync(at)) return
  fs.symlinkSync(target, at, 'junction')
}

/** 造一个「对任何 dsh 版本都不兼容」的金丝雀 bundle。 */
function makeCanary(root) {
  const dir = path.join(root, 'compat-canary')
  write(path.join(dir, 'package.json'), {
    name: 'compat-canary',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    // >=999.0.0 对**任何**真实 dsh 都不满足 —— 探测项必须与版本无关，
    // 否则会踩到「拿当前版本的合法范围去测老版本」的坑
    peerDependencies: { '@deepseek-ai/dsh': '>=999.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  write(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: compat-canary\n      name: 'compat-canary'\n")
  write(path.join(dir, 'index.js'), "export const name = 'compat-canary'\nexport function apply() {}\n")
  return dir
}

/** 用 dsh 自带的 headless 模板初始化一个最小 profile，再把两个 bundle 接进去。 */
function prepareProfile({ home, dshBin, canaryDir }) {
  const profileDir = path.join(home, 'profiles', PROFILE_NAME)
  // ① 让 dsh 自己把 profile 骨架建出来（免得我手抄错它的内部约定）。
  //    老版本（0.1.1-rc.2 实测）没有 --from-default-profile，所以要手工兜底。
  try {
    execFileSync(process.execPath, [
      dshBin, '--profile', PROFILE_NAME, '--from-default-profile', 'headless', '--dump-config',
    ], { env: { ...process.env, DSH_HOME: home }, stdio: 'ignore', timeout: 120_000 })
  } catch {
    // --dump-config 的退出码不稳定，只要骨架落盘了就算成功
  }
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    console.log('  （该版本没有 --from-default-profile，手工搭 profile 骨架）')
    write(path.join(profileDir, 'package.json'), {
      name: `dsh-profile-${PROFILE_NAME}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
    })
    write(path.join(profileDir, 'cordis.yml'), '[]\n')
    write(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  }
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    throw new Error(`dsh 没能初始化 profile：${profileDir}`)
  }

  // ② 接上两个 bundle
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    'dsh-compat-vet': `link:${PLUGIN_DIR}`,
    'compat-canary': `link:${canaryDir}`,
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  manifest.dsh = {
    ...(manifest.dsh ?? {}),
    profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles, 'compat-canary', 'dsh-compat-vet'] },
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  linkDir(PLUGIN_DIR, path.join(profileDir, 'node_modules', 'dsh-compat-vet'))
  linkDir(canaryDir, path.join(profileDir, 'node_modules', 'compat-canary'))
  return profileDir
}

/** 真启动一次，返回合并后的输出。 */
function boot({ home, dshBin }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dshBin, '--profile', PROFILE_NAME, 'hi'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    const timer = setTimeout(() => {
      output += '\n[verify-real-boot] 超时，已终止（插件告警应当在超时之前就打出来了）\n'
      child.kill()
    }, 90_000)
    child.on('close', () => { clearTimeout(timer); resolve(output) })
    child.on('error', (error) => { clearTimeout(timer); resolve(`${output}\n[verify-real-boot] 启动失败：${error.message}`) })
  })
}

const args = parseArgs(process.argv.slice(2))
const anchors = args.dsh ? [path.resolve(args.dsh)] : discoverAnchors()
if (anchors.length === 0) {
  console.log('没有找到任何 dsh 安装，无法做真机启动验证。')
  process.exit(0)
}

let failures = 0
const summary = []

for (const anchor of anchors) {
  const dshBin = path.join(path.dirname(anchor), 'lib', 'bin.js')
  if (!fs.existsSync(dshBin)) {
    console.log(`跳过 ${anchor}：找不到 ${dshBin}`)
    continue
  }
  const runtime = await probeRuntime({ installAnchor: anchor })
  const version = runtime.version ?? '(unknown)'
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshboot-'))
  console.log(`\n${'='.repeat(72)}\n真机启动：dsh ${version}（DSH_HOME=${home}）\n${'='.repeat(72)}`)

  try {
    const canaryDir = makeCanary(home)
    prepareProfile({ home, dshBin, canaryDir })
    const output = await boot({ home, dshBin })

    const sawPluginWarning = /dsh-compat-vet: 检测到/.test(output)
    const denies = runtime.builtIn.deniesAtStartup === true
    const wantPhrase = denies ? /会被拒绝加载/ : /会照常加载/
    const sawRightPhrase = wantPhrase.test(output)
    // 交叉核对：探测说「会拦下」时，dsh 真的应当把金丝雀跳过；说「不会拦」时就不该跳。
    // 这是「实测校准」这四个字唯一的硬证据 —— 结论必须与 dsh 的真实行为对得上。
    const dshSkippedCanary = /skipping profile bundle "compat-canary"/.test(output)
    const calibrationAgrees = dshSkippedCanary === denies
    const sawNoInjectError = !/without inject/.test(output)

    console.log(`  插件告警出现        : ${sawPluginWarning ? '✓' : '✗'}`)
    console.log(`  措辞与版本能力一致  : ${sawRightPhrase ? '✓' : '✗'}（期望「${denies ? '会被拒绝加载' : '会照常加载'}」）`)
    console.log(`  金丝雀被 dsh 拦下   : ${dshSkippedCanary ? '是' : '否'}`
      + `（探测结论：${denies ? '会拦' : '不会拦'}） → 交叉核对 ${calibrationAgrees ? '✓ 一致' : '✗ 不一致'}`)
    console.log(`  无 cordis 服务读取错误: ${sawNoInjectError ? '✓' : '✗'}`)
    console.log('  ---- 与插件相关的输出行 ----')
    for (const line of output.split('\n').filter((l) => /compat-vet|canary/.test(l)).slice(0, 8)) {
      console.log(`    ${line.trim().slice(0, 150)}`)
    }

    if (!sawPluginWarning) { failures += 1; console.log('  ✗ 插件告警没有出现') }
    if (!sawRightPhrase) { failures += 1; console.log('  ✗ 措辞与该版本能力不符') }
    if (!calibrationAgrees) { failures += 1; console.log('  ✗ 探测结论与 dsh 真实行为不一致 —— 校准不可信') }
    if (!sawNoInjectError) { failures += 1; console.log('  ✗ 出现了 cordis 服务读取错误（说明有地方没做防御性访问）') }
    summary.push(`${version}: 告警=${sawPluginWarning ? '有' : '无'}｜措辞=${sawRightPhrase ? '正确' : '不符'}`
      + `｜金丝雀被拦=${dshSkippedCanary ? '是' : '否'}（探测=${denies ? '会拦' : '不会拦'}，${calibrationAgrees ? '一致' : '不一致'}）`)
  } catch (error) {
    failures += 1
    console.log(`  ✗ 验证过程出错：${error.message}`)
    summary.push(`${version}: 出错 ${error.message}`)
  } finally {
    if (args.keep) console.log(`  （已保留临时目录：${home}）`)
    else fs.rmSync(home, { recursive: true, force: true })
  }
}

console.log(`\n${'='.repeat(72)}\n真机启动验证汇总\n${'='.repeat(72)}`)
for (const line of summary) console.log(`  · ${line}`)
console.log(failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项不通过。`)
process.exitCode = failures === 0 ? 0 : 1
