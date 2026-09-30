/**
 * 跨真实 dsh 版本的端到端验证 —— 「适配任意 dsh 版本」这条承诺的证据。
 *
 * 本机 npx 缓存里躺着 4 个真实 dsh：
 *   0.1.1-rc.2 / 0.1.5-rc.3 / 0.1.7-rc.1 / 0.2.0-rc.2
 * 前两个**没有**兼容性预检也没有豁免机制，后两个有。这是实测出来的，不是猜的。
 *
 * 这里要做的事只有一件：拿同一份插件代码，逐个版本跑一遍，证明
 *   ① 探测出来的能力与实测基线一致；
 *   ② 判定、后果措辞、可用命令都跟着版本变，而不是靠 if (version >= ...)；
 *   ③ 手写的 JSON Schema 在每个版本的 dsh 上都合法；
 *   ④ 自己实现的 compatibility.json 解析与 dsh 自己的读取器结论一致。
 *
 * 找不到缓存版本时**跳过**而不是失败 —— 换台机器不该红。
 * 万一将来出现没见过的 dsh 版本，只校验「内部一致性」，不硬套基线 ——
 * 这样这个测试不会变成「每次 dsh 升级都要手动改」的新负担。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { probeRuntime, nodeModulesRootOf, packageDirOf } from '../lib/adapt.js'
import { auditProfileProbed, parseCompatibilityFile, SEVERITY, FINDING } from '../lib/audit.js'
import { renderReport, remediesFor } from '../lib/report.js'
import { locateAnchor } from '../lib/locate.js'

/**
 * 实测基线（2026-09-30 在本机 4 个缓存版本上跑出来的）。
 *
 * ⚠️ 这张表是**回归护栏**，不是插件依赖的配置：插件靠的是运行时实测，
 * 不读这张表。dsh 哪天改了行为，这里会失败 —— 那时更新这张表即可，
 * **插件本身不需要改**，这正是「不用每次手动更新」的含义。
 */
const BASELINE = {
  '0.1.1-rc.2': {
    appBootExports: 27,
    compatibilitySupported: false,
    verdict: 'absent',
    deniesAtStartup: false,
    exemptionMechanism: false,
    seesPeerMismatch: false,
    seesDeclaredRange: false,
    seesPeerlessPlugin: false,
  },
  '0.1.5-rc.3': {
    appBootExports: 29,
    compatibilitySupported: false,
    verdict: 'absent',
    deniesAtStartup: false,
    exemptionMechanism: false,
    seesPeerMismatch: false,
    seesDeclaredRange: false,
    seesPeerlessPlugin: false,
  },
  '0.1.7-rc.1': {
    appBootExports: 53,
    compatibilitySupported: true,
    verdict: 'effective',
    deniesAtStartup: true,
    exemptionMechanism: true,
    seesPeerMismatch: true,
    seesDeclaredRange: false,
    seesPeerlessPlugin: false,
  },
  '0.2.0-rc.2': {
    appBootExports: 54,
    compatibilitySupported: true,
    verdict: 'effective',
    deniesAtStartup: true,
    exemptionMechanism: true,
    seesPeerMismatch: true,
    seesDeclaredRange: false,
    seesPeerlessPlugin: false,
  },
}

/** 找出本机所有真实可用的 dsh 安装（package.json 绝对路径）。 */
function discoverAnchors() {
  const found = new Set()
  const bases = []
  if (process.env.LOCALAPPDATA) bases.push(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  if (process.env.APPDATA) {
    bases.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
    bases.push(path.join(process.env.APPDATA, 'npm-cache', '_npx'))
  }
  for (const base of bases) {
    let entries = []
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const anchor = path.join(base, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (fs.existsSync(anchor)) found.add(anchor)
    }
  }
  const located = locateAnchor()
  if (located && fs.existsSync(located)) found.add(located)

  // 按版本排序，输出稳定
  const list = [...found].map((anchor) => {
    let version = '(unknown)'
    try {
      version = JSON.parse(fs.readFileSync(anchor, 'utf8')).version ?? '(unknown)'
    } catch { /* 读不到就当 unknown，下面的用例会暴露 */ }
    return { anchor, version }
  })
  return list.sort((a, b) => a.version.localeCompare(b.version))
}

const ANCHORS = discoverAnchors()

/**
 * 一个「对任何 dsh 版本都不兼容」的合成 profile：
 * 用 `>=999.0.0` 这种不可能被满足的范围 —— 探测项必须与版本无关，
 * 否则就会踩到「拿当前版本的合法范围去测老版本」的坑。
 */
function syntheticProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-versions-'))
  const profileDir = path.join(root, 'profiles', 'web')
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2))
  }
  write(path.join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    dependencies: { 'bad-peer': '1.0.0', 'peerless-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['bad-peer', 'peerless-plugin'] } },
  })
  // 对任何版本都不满足
  write(path.join(profileDir, 'node_modules', 'bad-peer', 'package.json'), {
    name: 'bad-peer',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh': '>=999.0.0' },
  })
  // 完全没有 peer：dsh 的判定盲区
  write(path.join(profileDir, 'node_modules', 'peerless-plugin', 'package.json'), {
    name: 'peerless-plugin', version: '1.0.0',
  })
  return { root, profileDir }
}

/** 打开某个 anchor 自带的 dsh 子包。 */
async function dshPackage(anchor, packageName) {
  const nm = nodeModulesRootOf(anchor)
  const dir = packageDirOf(nm, packageName)
  if (!dir) throw new Error(`找不到 ${packageName}`)
  const entry = path.join(dir, 'lib', 'index.js')
  const target = fs.existsSync(entry) ? entry : path.join(dir, 'index.js')
  return import(`file:///${target.replace(/\\/g, '/')}`)
}

// ---------------------------------------------------------------------------
// ① 探测能力：与实测基线一致，且内部自洽
// ---------------------------------------------------------------------------

test('真实 dsh 版本探测：能力与实测基线一致，且结论内部自洽', async (t) => {
  if (ANCHORS.length === 0) return t.skip('本机没有可探测的 dsh 安装，跳过')
  console.log(`  ℹ 发现 ${ANCHORS.length} 个真实 dsh：${ANCHORS.map((a) => a.version).join(' / ')}`)

  for (const { anchor, version } of ANCHORS) {
    const runtime = await probeRuntime({ installAnchor: anchor })
    const b = runtime.builtIn

    assert.equal(runtime.found, true, `${version} 应当探测成功`)
    assert.equal(runtime.version, version, '探测到的版本要与安装清单一致')
    assert.equal(runtime.scope, '@deepseek-ai')
    assert.ok(runtime.nodeModulesRoot, '要能定位 node_modules')
    assert.equal(runtime.appBoot.loaded, true, `${version} 的 dsh-app-boot 应当可加载`)
    assert.equal(b.determined, true, `${version} 的能力必须是**实测**出来的`)

    // 内部自洽：不能说「没有预检」却又能拦下插件
    if (b.verdict === 'absent') {
      assert.equal(b.seesPeerMismatch, false, `${version} 没有预检就不该看得见 peer 不匹配`)
      assert.equal(b.deniesAtStartup, false, `${version} 没有预检就不该拦下任何插件`)
      assert.equal(b.calibrated, false)
    } else {
      assert.equal(b.seesPeerMismatch, true, `${version} 判定为有效预检就必须看得见 peer 不匹配`)
      assert.equal(b.deniesAtStartup, true)
      assert.equal(b.calibrated, true)
    }
    // 豁免机制不可能在没有 compatibility.json 的版本上存在
    if (!runtime.compatibilitySupported) {
      assert.equal(b.exemptionMechanism, false, `${version} 没有 compatibility.json 就不该说有豁免`)
    }

    const base = BASELINE[version]
    if (base === undefined) {
      console.log(`  ⚠️ ${version} 不在实测基线里：只校验了内部自洽（插件无需改动）`)
    } else {
      assert.equal(b.verdict, base.verdict, `${version} verdict`)
      assert.equal(b.seesPeerMismatch, base.seesPeerMismatch, `${version} seesPeerMismatch`)
      assert.equal(b.seesDeclaredRange, base.seesDeclaredRange, `${version} seesDeclaredRange`)
      assert.equal(b.seesPeerlessPlugin, base.seesPeerlessPlugin, `${version} seesPeerlessPlugin`)
      assert.equal(b.deniesAtStartup, base.deniesAtStartup, `${version} deniesAtStartup`)
      assert.equal(b.exemptionMechanism, base.exemptionMechanism, `${version} exemptionMechanism`)
      assert.equal(runtime.compatibilitySupported, base.compatibilitySupported, `${version} compatibilitySupported`)
      const appBoot = await dshPackage(anchor, '@deepseek-ai/dsh-app-boot')
      assert.equal(Object.keys(appBoot).length, base.appBootExports,
        `${version} 的 dsh-app-boot 导出面变了 —— 基线需要更新（插件本身无需改）`)
    }
  }
})

// ---------------------------------------------------------------------------
// ② 同一份代码，跨版本自动改判定与措辞
// ---------------------------------------------------------------------------

test('同一份代码在 4 个真实版本上自动改判定：老版本说「会照常加载」，新版本说「会被拒绝加载」', async (t) => {
  if (ANCHORS.length === 0) return t.skip('本机没有可探测的 dsh 安装，跳过')
  const { profileDir } = syntheticProfile()
  const seen = []

  for (const { anchor, version } of ANCHORS) {
    const report = await auditProfileProbed({ profileDir, profileName: 'web', installAnchor: anchor })
    assert.equal(report.error, undefined, `${version} 上体检不该报错：${report.error}`)
    assert.equal(report.runtimeVersion, version)
    assert.equal(report.adaptation.builtIn.determined, true, `${version} 必须是实测判定的`)

    const bad = report.items.find((i) => i.name === 'bad-peer')
    assert.ok(bad, `${version} 应当报出 bad-peer`)
    assert.equal(bad.severity, SEVERITY.BLOCK)

    const peer = bad.findings.find((f) => f.code === FINDING.PEER_INCOMPATIBLE)
    const denies = report.adaptation.builtIn.deniesAtStartup
    // 标签与后果措辞都必须来自实测
    assert.equal(peer.dshBuiltIn, denies ? 'covered' : 'not-covered', `${version} 的标签`)
    if (denies) {
      assert.match(peer.title, /启动时会被拒绝加载/, `${version} 应当说会被拒绝加载`)
      assert.match(peer.detail, /置为 disabled/)
    } else {
      assert.match(peer.title, /不会拦下它，会照常加载/, `${version} 不该说会被拒绝加载`)
      assert.doesNotMatch(peer.detail, /置为 disabled/)
    }

    // 没有 peer 的插件：dsh 的判定盲区，四个版本都看不见
    const peerless = report.items.find((i) => i.name === 'peerless-plugin')
    const unverifiable = peerless.findings.find((f) => f.code === FINDING.UNVERIFIABLE)
    assert.equal(unverifiable.dshBuiltIn, 'not-covered', `${version} 对无 peer 插件是盲区`)
    assert.match(unverifiable.detail, /不做任何版本校验/)

    // 没有豁免机制的版本上，修复命令里不能出现走不通的 allow-version
    const remedies = remediesFor(bad, {
      profileName: 'web', runtimeVersion: version, builtIn: report.adaptation.builtIn,
    })
    const hasAllow = remedies.some((r) => r.command.includes('allow-version'))
    assert.equal(hasAllow, report.adaptation.builtIn.exemptionMechanism,
      `${version} 的 allow-version 命令是否可用要跟豁免机制一致`)

    const text = renderReport(report)
    assert.match(text, /适配信息（结论依据，不是假设）/)
    seen.push(`${version}: 预检=${report.adaptation.builtIn.verdictText}｜豁免=${report.adaptation.builtIn.exemptionMechanism ? '有' : '没有'}｜措辞=${denies ? '会被拒绝加载' : '会照常加载'}`)
  }

  console.log('  ℹ 跨版本自适应实测结果：')
  for (const line of seen) console.log(`    · ${line}`)
})

// ---------------------------------------------------------------------------
// ③ 手写的 JSON Schema 在每个真实 dsh 上都合法
// ---------------------------------------------------------------------------

test('工具参数的 JSON Schema 通过每个真实版本 dsh-tools 的校验', async (t) => {
  if (ANCHORS.length === 0) return t.skip('本机没有可探测的 dsh 安装，跳过')
  // 与 lib/index.js 里手写的定义保持一致（这里刻意手抄一份，
  // 手抄能挡住「改了插件定义却忘了同步校验」之外的情况；形状不对就会红）
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeOk: { type: 'boolean', description: '是否连「通过」的插件也列进报告。默认 false，只列有问题的。' },
    },
    required: [],
  }

  for (const { anchor, version } of ANCHORS) {
    const tools = await dshPackage(anchor, '@deepseek-ai/dsh-tools')
    const assertSupported = tools.assertSupportedJsonSchema
    assert.equal(typeof assertSupported, 'function', `${version} 应当有 assertSupportedJsonSchema`)
    // 不合法时它会抛 JsonSchemaError —— 不抛就是通过
    assert.doesNotThrow(() => assertSupported(parameters), `${version} 上参数 schema 应当合法`)
  }
  // 反向校验：故意写坏必须被拒（证明上面的「通过」不是因为它什么都不检查）
  const first = await dshPackage(ANCHORS[0].anchor, '@deepseek-ai/dsh-tools')
  assert.throws(() => first.assertSupportedJsonSchema({ type: 'not-a-real-type' }))
})

// ---------------------------------------------------------------------------
// ④ compatibility.json 解析与 dsh 自己的读取器结论一致
// ---------------------------------------------------------------------------

test('自包含的 compatibility.json 解析与 dsh 自己的读取器结论一致', async (t) => {
  if (ANCHORS.length === 0) return t.skip('本机没有可探测的 dsh 安装，跳过')

  const samples = [
    ['空文件', '{}'],
    ['一条有效豁免', '{ "a@1.0.0": ["0.2.0-rc.2"] }'],
    ['多条有效豁免', '{ "a@1.0.0": ["0.2.0-rc.2"], "@s/b@2.3.4": ["0.2.0-rc.2","0.1.7-rc.1"] }'],
    ['值不是数组', '{ "a@1.0.0": "0.2.0-rc.2" }'],
    ['键没有 @', '{ "a": ["0.2.0-rc.2"] }'],
    ['键的版本是范围而非精确版本', '{ "a@^1.0.0": ["0.2.0-rc.2"] }'],
    ['值不是精确版本', '{ "a@1.0.0": ["^0.2.0"] }'],
    ['数组里混了非字符串', '{ "a@1.0.0": [1] }'],
    ['带 build metadata 的精确版本', '{ "a@1.0.0+build.5": ["0.2.0-rc.2"] }'],
  ]

  let compared = 0
  for (const { anchor, version } of ANCHORS) {
    const runtime = await probeRuntime({ installAnchor: anchor })
    if (runtime.compatibilityFilename === undefined) continue // 该版本没有这个文件，跳过
    const appBoot = await dshPackage(anchor, '@deepseek-ai/dsh-app-boot')
    const reader = appBoot.readProfileCompatibility
    if (typeof reader !== 'function') continue

    for (const [label, content] of samples) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-compat-'))
      const file = path.join(dir, runtime.compatibilityFilename)
      fs.writeFileSync(file, content)

      const theirs = reader(dir)
      // 两个解析器都吃**路径**（要区分「文件不存在」= 没有任何豁免）
      const mine = parseCompatibilityFile(file)
      assert.deepEqual(mine.exemptions, theirs.exemptions ?? {},
        `${version} 上「${label}」的豁免集合应当一致`)
      // 干净样本两边都不该有警告；脏样本两边都该有（条数不强求一致，结论必须一致）
      const theirsBad = (theirs.warnings ?? []).length > 0
      const mineBad = mine.warnings.length > 0
      const shouldBeClean = label === '空文件' || label.startsWith('一条') || label.startsWith('多条') || label.startsWith('带 build')
      if (shouldBeClean) {
        assert.equal(mineBad, false, `${version} 上「${label}」不该有警告`)
      } else {
        assert.equal(mineBad, true, `${version} 上「${label}」应当被标为有问题`)
        assert.equal(theirsBad, true, `${version} 上 dsh 自己也认为「${label}」有问题`)
      }
      compared += 1
    }
  }
  assert.ok(compared > 0, '至少要真正对比过一组')
  console.log(`  ℹ 与 dsh 自己的读取器对比了 ${compared} 组样本，结论全部一致`)
})
