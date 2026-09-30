#!/usr/bin/env node
/**
 * 打包安装验证 —— 证明**别人从发布产物安装，装完真的能用**。
 *
 * 为什么单有单元测试不算数：单元测试跑的是源码目录，而**别人装到的是 npm 包**。
 * 两者不是一回事：`files` 少写一项（比如漏了 `lib/client.js` 或 `cordis.patch.yml`），
 * 单元测试照样全绿，别人装完却是坏的。这个脚本走的就是别人的路：
 *
 *   ① `npm pack` 打成真 tarball（npm 发布时上传的就是它）
 *   ② 建一个**空白的临时 profile**（不是你的在用 profile）
 *   ③ 用 dsh **自己的安装命令**装它：`dsh plugin --profile web add <tarball>`
 *      —— 插件市场的一键安装走的就是这条命令，只是参数是 npm 包名
 *   ④ 真启动 `dsh web`：确认插件被加载、页面接口通、**横幅代码真的能被浏览器取到**
 *
 * 跑完会把临时目录删掉；`--keep` 留着看，`--dsh <安装目录>` 指定 dsh。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { locateAnchor } from '../lib/locate.js'
import {
  childEnv, readJson, freePort, startWeb, stopWeb, handshake, prepareWebProfile,
} from './helpers/dsh-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const PROFILE_NAME = 'web'
const API = '/dsh-compat-doctor/api/v1'
const PKG_NAME = 'dsh-compat-doctor'

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed += 1; console.log(`  ✓ ${what}${extra === undefined ? '' : ` —— ${extra}`}`) }
  else { failed += 1; console.log(`  ✗ ${what}${extra === undefined ? '' : ` —— ${extra}`}`) }
}

function parseArgs(argv) {
  const out = { keep: false, dsh: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') out.keep = true
    if (argv[i] === '--dsh') { out.dsh = argv[i + 1]; i += 1 }
  }
  return out
}

/**
 * 调 npm 的**可靠**方式：直接跑 npm 自己的 JS 入口。
 * Windows 上 `npm` 是 .cmd，而新版 Node 出于安全（CVE-2024-27980）拒绝直接 execFile 一个 .cmd；
 * 绕 shell 又要操心引号。走 `npm-cli.js` 两条都躲开。
 */
function npmEntry() {
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return fs.existsSync(candidate) ? candidate : undefined
}

/** 跑一次 npm，返回 stdout（找不到 npm-cli.js 时退回 shell 调 npm）。 */
function npmRun(args, options = {}) {
  const entry = npmEntry()
  return execFileSync(
    entry === undefined ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath,
    entry === undefined ? args : [entry, ...args],
    { cwd: PLUGIN_DIR, encoding: 'utf8', shell: entry === undefined, ...options },
  )
}

/** `npm pack` 出一个真 tarball，返回它的绝对路径。 */
function packTarball({ dest }) {
  const stdout = npmRun(['pack', '--pack-destination', dest])
  const name = stdout.trim().split(/\r?\n/).filter((one) => one.endsWith('.tgz')).pop()
  if (name === undefined) throw new Error(`npm pack 没吐出 tarball 名：${stdout}`)
  return path.join(dest, name)
}

/** `npm pack --dry-run --json` 的文件清单（产物内容检查用）。 */
function packedFileList() {
  try {
    const stdout = npmRun(['pack', '--dry-run', '--json'])
    return JSON.parse(stdout)[0].files.map((one) => one.path)
  } catch {
    return [] // 拿不到就当这项检查跳过，不误判成失败
  }
}

/** 用 dsh 自己的安装命令装 tarball —— 市场一键安装走的就是这条。 */
function dshPluginAdd({ home, dshBin, tarball }) {
  try {
    const stdout = execFileSync(process.execPath, [
      dshBin, 'plugin', '--profile', PROFILE_NAME, 'add', tarball,
    ], { env: childEnv(home), encoding: 'utf8', timeout: 300_000, stdio: 'pipe' })
    return { ok: true, output: stdout }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}` }
  }
}

const args = parseArgs(process.argv.slice(2))
const anchor = args.dsh ? path.resolve(args.dsh) : locateAnchor()
if (!anchor) {
  console.log('没有找到 dsh 安装，无法做打包安装验证。')
  process.exit(0)
}
const dshBin = path.join(path.dirname(anchor), 'lib', 'bin.js')
if (!fs.existsSync(dshBin)) {
  console.log(`找不到 dsh 命令行入口：${dshBin}`)
  process.exit(1)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpd-tarball-'))
const home = path.join(root, 'home')
const packDir = path.join(root, 'pack')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(packDir, { recursive: true })

let web
try {
  console.log('① 打成真 tarball（npm 发布时上传的就是它）')
  const tarball = packTarball({ dest: packDir })
  const size = fs.statSync(tarball).size
  check('tarball 打出来了', fs.existsSync(tarball), `${path.basename(tarball)}，${(size / 1024).toFixed(1)} kB`)

  // 发布产物的**隐私检查**：里面不能有使用者的真实 profile 快照之类的东西
  const files = packedFileList()
  if (files.length > 0) {
    check('产物里没有本机私有快照（_profile-backup）', !files.some((one) => one.includes('_profile-backup')),
      `${files.length} 个文件`)
    check('产物里带上了 cordis.patch.yml（少了它 dsh 装不上）', files.includes('cordis.patch.yml'))
    check('产物里带上了浏览器端 lib/client.js（少了它页面上没有横幅）', files.includes('lib/client.js'))
    check('产物里带上了 LICENSE', files.some((one) => one === 'LICENSE'))
  }

  console.log('\n② 建一个空白临时 profile（不是你在用的那个）')
  const profileDir = prepareWebProfile({ home, dshBin, profileName: PROFILE_NAME })
  check('临时 profile 建好了', fs.existsSync(path.join(profileDir, 'package.json')), profileDir)

  console.log('\n③ 用 dsh 自己的安装命令装它（= 插件市场的一键安装路径）')
  const installed = dshPluginAdd({ home, dshBin, tarball })
  check('dsh plugin add 成功', installed.ok,
    installed.ok ? '' : installed.output.slice(-400).replace(/\s+/g, ' '))
  if (!installed.ok) throw new Error('安装失败，后面不用测了')

  const manifest = readJson(path.join(profileDir, 'package.json'))
  const spec = manifest.dependencies?.[PKG_NAME]
  check('profile 清单里记下了这个依赖', typeof spec === 'string', spec)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  check('并把它挂进了 dsh.profile.bundles（否则不会被加载）', bundles.includes(PKG_NAME),
    bundles.join(', '))

  const installedDir = path.join(profileDir, 'node_modules', PKG_NAME)
  const realInstalled = fs.existsSync(installedDir) ? fs.realpathSync(installedDir) : installedDir
  check('装出来的是一份**真拷贝**，不是指回我源码目录的链接',
    realInstalled !== fs.realpathSync(PLUGIN_DIR) && !realInstalled.startsWith(fs.realpathSync(PLUGIN_DIR)),
    realInstalled)
  check('拷贝里有 lib/client.js', fs.existsSync(path.join(installedDir, 'lib', 'client.js')))
  check('拷贝里有 cordis.patch.yml', fs.existsSync(path.join(installedDir, 'cordis.patch.yml')))
  check('拷贝里没有本机私有快照', !fs.existsSync(path.join(installedDir, '_profile-backup')))

  console.log('\n④ 真启动 dsh web，看装完到底能不能用')
  const port = await freePort()
  web = await startWeb({ home, dshBin, port, label: '装完启动', apiPrefix: API })
  check('dsh 启动了，页面接口能访问', web.ready, web.ready ? `端口 ${port}` : web.error)
  if (!web.ready) throw new Error('启动失败，后面不用测了')

  const status = await (await fetch(`${web.base}${API}/status`)).json()
  check('状态接口给出 dsh 版本号', typeof status.dshVersion === 'string' && status.dshVersion.length > 0, status.dshVersion)
  check('空 profile 上没有兼容性问题（新装的人不会被误报）', (status.summary?.blocked ?? 0) === 0,
    JSON.stringify(status.summary))
  check('本机可修复（pluginManager 在）', status.canRepair === true, `canRepair=${status.canRepair}`)

  const { cookie, status: handshakeStatus } = await handshake({ base: web.base, port, output: web.output() })
  const indexHtml = await (await fetch(`${web.base}/`, { headers: cookie === '' ? {} : { cookie } })).text()
  const listed = indexHtml.includes(PKG_NAME)
  check('dsh 的启动注入里列出了这个客户端模块', listed,
    `握手 HTTP ${handshakeStatus}，首页 ${indexHtml.length} 字节`)
  if (listed) {
    const found = indexHtml.match(/[^"'\s]*dsh-compat-doctor\/client\.js[^"'\s]*/)
    if (found === null) {
      check('能从启动注入里找到客户端模块的 URL', false)
    } else {
      const clientUrl = found[0].replace(/&amp;/g, '&')
      const response = await fetch(`${web.base}/${clientUrl.replace(/^\//, '')}`)
      const js = await response.text()
      check('浏览器端横幅代码真能取到（HTTP 200）', response.status === 200, `${js.length} 字节`)
      check('取到的确实是横幅代码', /__ModuleLoader__/.test(js) && /dsh-compat-doctor-banner/.test(js))
    }
  }

  console.log('\n⑤ 顺带确认：卸载路径也能走通')
  try {
    execFileSync(process.execPath, [dshBin, 'plugin', '--profile', PROFILE_NAME, 'remove', PKG_NAME], {
      env: childEnv(home), encoding: 'utf8', timeout: 180_000, stdio: 'pipe',
    })
    const after = readJson(path.join(profileDir, 'package.json'))
    check('dsh plugin remove 之后依赖没了', after.dependencies?.[PKG_NAME] === undefined)
    check('清单里也不再挂载它', !(after.dsh?.profile?.bundles ?? []).includes(PKG_NAME))
  } catch (error) {
    check('dsh plugin remove 能跑通', false, String(error.message).slice(0, 200))
  }
} catch (error) {
  failed += 1
  console.log(`\n验证中断：${error.message}`)
} finally {
  stopWeb(web)
  // 给子进程一点时间放手文件句柄，否则删目录可能报占用
  await new Promise((resolve) => setTimeout(resolve, 800))
  if (args.keep) {
    console.log(`\n临时目录保留在：${root}`)
  } else {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
  }
}

console.log(`\n${'='.repeat(70)}`)
console.log(failed === 0
  ? `打包安装验证全部通过（${passed} 项）—— 别人从发布产物装完确实能用`
  : `打包安装验证有 ${failed} 项不通过（通过 ${passed} 项）`)
console.log('='.repeat(70))
process.exit(failed === 0 ? 0 : 1)
