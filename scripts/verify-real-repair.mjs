#!/usr/bin/env node
/**
 * 真机「一键修复」验证 —— 在**隔离的真实 dsh** 上完整走一遍用户的那条路：
 *
 *   ① 造一个必然不兼容的插件（`compat-canary`，要求 dsh >=999.0.0），装进一个临时 profile；
 *   ② 真启动一个 dsh web 服务（临时 DSH_HOME、随机端口）；
 *   ③ 请求 `GET /dsh-compat-doctor/api/v1/status` —— 断言页面拿到的数据里
 *      **同时有插件的版本号和当前 dsh 的版本号**（用户提的硬要求）；
 *   ④ 请求 `POST /dsh-compat-doctor/api/v1/repair`（action=quarantine = 页面上按「1」走的那条路）；
 *   ⑤ 断言修复走的是 **dsh 自己的 pluginManager 服务**（而不是我自己写文件）、
 *      **改动真的落盘**、本插件复检干净；
 *   ⑥ **再启动一次 dsh** —— 断言清单里已经没有被隔离的插件，
 *      且启动输出里不再有 `skipping profile bundle "compat-canary"`、也没有本插件的告警。
 *
 * 为什么非要真启动两次：用户的要求是「100% 避免插件版本冲突导致 dsh **下次启动**失败」。
 * 「下次启动」这件事没法靠单元测试证明 —— 只能真的启动下一次，然后看 dsh 自己怎么说。
 *
 * 安全性（本脚本绝不碰用户的真实环境）：
 *   · 全程在一个临时 DSH_HOME 里跑，随机端口；
 *   · 子进程环境里**删掉**继承来的 DSH_PROFILE_DIR / DSH_PROFILE（它们指向用户真实 profile）；
 *   · 不动 ~/.dsh，不影响正在运行的 Web GUI。
 *
 * 用法：
 *   node scripts/verify-real-repair.mjs                # 用本机当前的 dsh
 *   node scripts/verify-real-repair.mjs --dsh <anchor> # 指定 dsh 安装
 *   node scripts/verify-real-repair.mjs --keep         # 保留临时目录
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { locateAnchor } from '../lib/locate.js'
// 真机验证的公共部件（childEnv / 启停 dsh / 建 profile 骨架）都在这里
import {
  childEnv, write, linkDir, freePort, startWeb, stopWeb, handshake, prepareWebProfile,
} from './helpers/dsh-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
// 必须叫 web：`dsh web` 这个子命令本身就隐含 `--profile web`，再传一个 --profile 会被拒
const PROFILE_NAME = 'web'
const API = '/dsh-compat-doctor/api/v1'

function parseArgs(argv) {
  const out = { keep: false, dsh: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') out.keep = true
    if (argv[i] === '--dsh') { out.dsh = argv[i + 1]; i += 1 }
  }
  return out
}

/**
 * 一个对任何 dsh 版本都不兼容、但确实是个合法 bundle 的插件。
 */
function makeCanary(root) {
  const dir = path.join(root, 'compat-canary')
  write(path.join(dir, 'package.json'), {
    name: 'compat-canary',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    // >=999.0.0 对任何真实 dsh 都不满足 —— 探测项必须与版本无关
    peerDependencies: { '@deepseek-ai/dsh': '>=999.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  write(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: compat-canary\n      name: 'compat-canary'\n")
  write(path.join(dir, 'index.js'), "export const name = 'compat-canary'\nexport function apply() {}\n")
  return dir
}

/** 用 dsh 自带的 web 模板建 profile（要 webServer 与 pluginManager 都在），再接上两个 bundle。 */
function prepareProfile({ home, dshBin, canaryDir }) {
  const profileDir = prepareWebProfile({ home, dshBin, profileName: PROFILE_NAME })

  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    'dsh-compat-doctor': `link:${PLUGIN_DIR}`,
    'compat-canary': `link:${canaryDir}`,
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  manifest.dsh = {
    ...(manifest.dsh ?? {}),
    profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles, 'compat-canary', 'dsh-compat-doctor'] },
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  linkDir(PLUGIN_DIR, path.join(profileDir, 'node_modules', 'dsh-compat-doctor'))
  linkDir(canaryDir, path.join(profileDir, 'node_modules', 'compat-canary'))
  return profileDir
}

const args = parseArgs(process.argv.slice(2))
const anchor = args.dsh ? path.resolve(args.dsh) : locateAnchor()
if (!anchor) {
  console.log('没有找到 dsh 安装，无法做真机修复验证。')
  process.exit(0)
}
const dshBin = path.join(path.dirname(anchor), 'lib', 'bin.js')
if (!fs.existsSync(dshBin)) {
  console.log(`找不到 dsh 命令行入口：${dshBin}`)
  process.exit(1)
}

let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  if (!ok) failures += 1
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshfix-'))
console.log(`${'='.repeat(74)}\n真机「一键修复」验证（DSH_HOME=${home}）\n${'='.repeat(74)}`)

let first
try {
  const canaryDir = makeCanary(home)
  prepareProfile({ home, dshBin, canaryDir })
  const manifestPath = path.join(home, 'profiles', PROFILE_NAME, 'package.json')
  const before = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  check('准备：金丝雀已在 dsh.profile.bundles 里', before.dsh.profile.bundles.includes('compat-canary'))

  // ---- 第一次启动：页面接口应当报出冲突 ----
  const port1 = await freePort()
  console.log(`\n① 启动 dsh web（端口 ${port1}），检查页面接口拿到的数据`)
  first = await startWeb({ home, dshBin, port: port1, label: '第一次启动', apiPrefix: API })
  if (!first.ready) {
    check('dsh web 起来了', false, first.error)
    console.log(first.output().split('\n').slice(-25).join('\n'))
  } else {
    check('dsh web 起来了，页面接口可访问', true)

    const status = await (await fetch(`${first.base}${API}/status`)).json()
    const canary = (status.problems ?? []).find((p) => p.name === 'compat-canary')
    check('状态里点名了 compat-canary', canary !== undefined)
    check('状态里带**插件版本号**', canary?.version === '1.0.0', canary?.version)
    check('状态里带**当前 dsh 版本号**', typeof status.dshVersion === 'string' && status.dshVersion.length > 0, status.dshVersion)
    check('状态里说明本机能不能真修（pluginManager 在不在）', typeof status.canRepair === 'boolean', `canRepair=${status.canRepair}`)
    check('默认动作是隔离（可逆、不需联网）', canary?.defaultAction === 'quarantine', canary?.defaultAction)

    // ---- 页面横幅是不是真会被浏览器加载：查 dsh 自己的启动注入 ----
    // 只把 package.json 写对还不够 —— 要证明 dsh 的客户端模块系统**真的收录并派发**了它。
    // 首页有浏览器鉴权（签名 cookie）：照浏览器的做法，先访问 dsh 打印的带凭证 URL 换 cookie。
    const { cookie, status: handshakeStatus } = await handshake({ base: first.base, port: port1, output: first.output() })
    const indexHtml = await (await fetch(`${first.base}/`, { headers: cookie === '' ? {} : { cookie } })).text()
    const listed = indexHtml.includes('dsh-compat-doctor')
    check('dsh 的启动注入里列出了本插件的客户端模块', listed,
      `握手 HTTP ${handshakeStatus}，cookie ${cookie === '' ? '无' : '已拿到'}，首页 ${indexHtml.length} 字节`)
    if (!listed) {
      console.log(`  （首页开头：${indexHtml.slice(0, 300).replace(/\s+/g, ' ')}）`)
      console.log(`  （启动输出里的 URL：${(first.output().match(/https?:\/\/[^\s"']+/g) ?? []).join(' | ') || '无'}）`)
    } else {
      const found = indexHtml.match(/[^"'\s]*dsh-compat-doctor\/client\.js[^"'\s]*/)
      if (found === null) {
        check('能从启动注入里找到客户端模块的 URL', false)
      } else {
        const clientUrl = found[0].replace(/&amp;/g, '&')
        const clientResponse = await fetch(`${first.base}/${clientUrl.replace(/^\//, '')}`)
        const clientJs = await clientResponse.text()
        check('客户端横幅的代码能真的取到（HTTP 200）', clientResponse.status === 200,
          `URL=${clientUrl}`)
        check('取到的确实是横幅代码', /__ModuleLoader__/.test(clientJs) && /dsh-compat-doctor-banner/.test(clientJs),
          `${clientJs.length} 字节`)
      }
    }

    // ---- 发起修复：这就是页面上按「1」走的那条路 ----
    console.log('\n② 走页面接口发起修复（action=quarantine，等价于页面上按「1」）')
    const started = await fetch(`${first.base}${API}/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'quarantine', name: 'compat-canary' }),
    })
    check('修复请求被接受', started.status === 202, `HTTP ${started.status}`)
    const { jobId } = await started.json()

    let job
    for (let i = 0; i < 120; i += 1) {
      const poll = await (await fetch(`${first.base}${API}/repair?id=${jobId}`)).json()
      job = poll.job
      if (job.state !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const result = job?.result ?? {}
    check('修复作业执行完毕', job?.state === 'done', job?.state)
    check('修复成功', result.ok === true, result.error)
    check('走的是 dsh 自己的 pluginManager 服务（不是我自己写文件）', result.usedDshService === true)
    check('改动**真的落盘了**（下次启动读到的就是新状态）', result.persisted === true, result.persistedDetail)
    check('本插件复检：冲突项归零', result.clearedByMe === true)
    check('综合判定：已验证修复', result.verified === true)
    check('该动作属于「保证消除冲突」那一类', result.guaranteed === true)
    check('执行结果里说明了是否需要重启', typeof result.applicationText === 'string' && result.applicationText.length > 0, result.applicationText)
    console.log(`  · dsh 本进程的即时复查：${result.clearedByDsh === true ? '已不再报它不兼容'
      : result.clearedByDsh === false ? '仍报旧结论（属正常：本进程的重估不是同步的，重启后按新状态加载）' : '问不到'}`)
    console.log(`  · dsh 返回的 application=${result.application}`)
    console.log('  ---- 修复步骤（页面上显示的就是这些）----')
    for (const step of job?.steps ?? []) {
      console.log(`    · ${step.label}${step.detail ? ` —— ${String(step.detail).slice(0, 110)}` : ''}`)
    }

    const afterRepair = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    check('清单里已摘掉 compat-canary', !afterRepair.dsh.profile.bundles.includes('compat-canary'),
      afterRepair.dsh.profile.bundles.join(', '))
    check('依赖仍然保留（隔离 ≠ 卸载，随时能恢复）', afterRepair.dependencies['compat-canary'] !== undefined)

    const after = await (await fetch(`${first.base}${API}/status?force=1`)).json()
    check('重新体检：不再报它冲突', !(after.problems ?? []).some((p) => p.name === 'compat-canary'))
  }
} catch (error) {
  failures += 1
  console.log(`  ✗ 验证过程出错：${error.message}`)
} finally {
  stopWeb(first)
  // 等端口释放，避免第二次启动抢不到
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

// ---- 第二次启动：用户真正关心的那句「下次启动不再失败」 ----
console.log('\n③ **再启动一次 dsh** —— 这一步才是「100% 避免下次启动失败」的证据')
let second
try {
  const port2 = await freePort()
  second = await startWeb({ home, dshBin, port: port2, label: '第二次启动', apiPrefix: API })
  if (!second.ready) {
    check('第二次也起得来', false, second.error)
    console.log(second.output().split('\n').slice(-25).join('\n'))
  } else {
    check('第二次启动正常', true)
    const output = second.output()
    check('启动输出里**没有**再跳过 compat-canary', !/skipping profile bundle "compat-canary"/.test(output))
    check('启动告警消失（说明已经没冲突了）', !/dsh-compat-doctor: 检测到/.test(output))
    const status = await (await fetch(`${second.base}${API}/status`)).json()
    check('第二次启动的体检：0 项冲突', (status.summary?.problems ?? -1) === 0,
      `blocked=${status.summary?.blocked} warned=${status.summary?.warned}`)
    const lines = output.split('\n').filter((one) => /compat-canary|plugin-doctor/.test(one)).slice(0, 6)
    if (lines.length > 0) {
      console.log('  ---- 第二次启动里与本插件/金丝雀相关的行 ----')
      for (const line of lines) console.log(`    ${line.trim().slice(0, 150)}`)
    }
  }
} catch (error) {
  failures += 1
  console.log(`  ✗ 第二次启动验证出错：${error.message}`)
} finally {
  stopWeb(second)
  if (args.keep) {
    console.log(`\n（已保留临时目录：${home}）`)
  } else {
    await new Promise((resolve) => setTimeout(resolve, 800))
    fs.rmSync(home, { recursive: true, force: true })
  }
}

console.log(`\n${'='.repeat(74)}\n真机修复验证${failures === 0 ? '全部通过' : `有 ${failures} 项不通过`}\n${'='.repeat(74)}`)
process.exitCode = failures === 0 ? 0 : 1
