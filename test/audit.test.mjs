/**
 * 审计引擎测试。用临时目录搭一个假 profile，逐条验证每种发现，
 * 特别是**「dsh 内置预检不会发现」的那几类** —— 那是本插件存在的理由。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditProfile, FINDING, SEVERITY, evaluateManifest, resolverOf } from '../lib/audit.js'
import { renderReport, renderStartupWarning, remediesFor } from '../lib/report.js'
import { locateAnchor } from '../lib/locate.js'

const RUNTIME = '0.2.0-rc.2'
const NODE = process.versions.node
let counter = 0

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/**
 * 一个「已实测校准过」的假运行时描述，语义等价于 dsh 0.2.0-rc.2 的实测结果：
 * 会因 peer 不匹配拦下插件，但对「没有 peer 的插件」和「非标准版本声明」都是盲区。
 *
 * 用假描述而不用真探测，是为了让这些用例**不依赖本机装了什么 dsh** —— 真探测的
 * 端到端验证另有 test/versions.test.mjs 用 4 个真实版本跑。
 */
function fakeRuntime(spec = {}) {
  const seesPeerMismatch = spec.seesPeerMismatch ?? true
  return {
    anchor: spec.anchor,
    found: true,
    version: spec.version ?? RUNTIME,
    versionSource: '测试注入',
    packageName: '@deepseek-ai/dsh',
    scope: '@deepseek-ai',
    nodeModulesRoot: spec.nodeModulesRoot,
    appBoot: { loaded: true },
    profilesDirName: 'profiles',
    patchFilename: 'cordis.patch.yml',
    compatibilityFilename: 'compatibility.json',
    compatibilitySupported: spec.exemptionMechanism ?? true,
    defaultBundles: spec.defaultBundles ?? ['@deepseek-ai/dsh-base'],
    optionalBundles: [],
    readers: {},
    builtIn: {
      verdict: spec.verdict ?? (seesPeerMismatch ? 'effective' : 'absent'),
      determined: spec.determined ?? true,
      calibrated: spec.calibrated ?? seesPeerMismatch,
      seesPeerMismatch,
      seesPeerlessPlugin: spec.seesPeerlessPlugin ?? false,
      seesDeclaredRange: spec.seesDeclaredRange ?? false,
      deniesAtStartup: spec.deniesAtStartup ?? seesPeerMismatch,
      exemptionMechanism: spec.exemptionMechanism ?? true,
    },
    notes: spec.notes ?? [],
  }
}

/**
 * 搭一个假 profile。
 * @param {object} spec
 * @param {Record<string,string>} [spec.dependencies] 依赖名 → spec
 * @param {string[]} [spec.bundles] bundles 列表
 * @param {Record<string,object>} [spec.plugins] 依赖名 → 假 manifest
 * @param {Record<string,string[]>} [spec.exemptions] compatibility.json 的豁免（**裸表**）
 * @param {object} [spec.compatibilityRaw] 直接写入 compatibility.json 的原始内容
 * @param {string[]} [spec.installationOwned] 由 dsh 安装提供的包名
 * @param {string} [spec.anchorVersion] dsh 运行时版本
 */
function fixture(spec) {
  counter += 1
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-doctor-${counter}-`))
  const profileDir = path.join(root, 'profiles', 'web')
  const anchor = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

  write(anchor, { name: '@deepseek-ai/dsh', version: spec.anchorVersion ?? RUNTIME })
  write(path.join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: spec.dependencies ?? {},
    dsh: { profile: { bundles: spec.bundles ?? Object.keys(spec.dependencies ?? {}) } },
  })
  // ⚠️ compatibility.json 的内容是**裸的豁免表**，不是 { exemptions: ... }
  // （dsh 的写入端是 JSON.stringify(exemptions)；{exemptions,warnings,rewritable}
  //  是读取函数的返回值）。这里必须按真实格式写，否则测试会跟着代码一起错。
  if (spec.compatibilityRaw !== undefined) {
    write(path.join(profileDir, 'compatibility.json'), spec.compatibilityRaw)
  } else if (spec.exemptions) {
    write(path.join(profileDir, 'compatibility.json'), spec.exemptions)
  }
  for (const [name, manifest] of Object.entries(spec.plugins ?? {})) {
    write(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), manifest)
  }
  for (const name of spec.installationOwned ?? []) {
    write(path.join(root, 'node_modules', ...name.split('/'), 'package.json'), { name, version: '0.2.0-rc.2' })
  }
  return {
    root,
    profileDir,
    anchor,
    runtime: fakeRuntime({ ...spec.runtime, anchor, nodeModulesRoot: path.join(root, 'node_modules') }),
  }
}

const itemOf = (report, name) => report.items.find((i) => i.name === name)
const codesOf = (report, name) => itemOf(report, name).findings.map((f) => f.code)

test('定位不到 dsh 时：dsh 自己的 bundle 只报「无法验证」，**绝不误报成「没装」**', () => {
  // 这是真机上抓到的假警报：不带 anchor（也拿不到运行时描述）时，
  // `@deepseek-ai/dsh-base` 这类 dsh 安装自带的 bundle 会被报成
  // `bundle-unresolved [阻断]「bundles 里引用了但没装」` —— 而它其实好好地在安装目录里。
  // 后果不只是吓人：页面上会给出「隔离 @deepseek-ai/dsh-base」这个按钮，
  // 真按下去会把整个 Web GUI 弄坏。
  const f = fixture({
    dependencies: { 'dsh-cost-meter': '^1.7.35' },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'],
  })
  // 刻意**什么都不传**：没有 anchor、没有 runtime —— 「定位不到 dsh」的那种处境
  const report = auditProfile({ profileDir: f.profileDir, profileName: 'web' })

  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const item = itemOf(report, name)
    assert.equal(item.severity, SEVERITY.INFO, `${name} 不能报成阻断`)
    assert.deepEqual(codesOf(report, name), [FINDING.BUNDLE_UNRESOLVED])
    assert.match(item.findings[0].title, /无法验证/)
  }
  assert.equal(report.summary.blocked, 0)
  assert.equal(report.summary.bundleIssues, 0)

  // 但第三方包在 bundles 里既不是依赖、又没装 —— 这仍然要报（而且我们要敢报）
  const missing = fixture({ dependencies: {}, bundles: ['some-third-party'] })
  const report2 = auditProfile({ profileDir: missing.profileDir, profileName: 'web' })
  assert.equal(itemOf(report2, 'some-third-party').severity, SEVERITY.BLOCK)
})

/**
 * 用 fixture 的运行时描述跑一次审计。
 * 等价于「已经对本机 dsh 做过实测校准」的调用方式，标签与后果描述都取自描述里的能力集。
 */
const audit = (f, extra = {}) => auditProfile({
  profileDir: f.profileDir,
  profileName: 'web',
  installAnchor: f.anchor,
  runtime: f.runtime,
  ...extra,
})

test('peer 不兼容且无豁免 → BLOCK，且 dsh 内置检查同样会发现', () => {
  const f = fixture({
    dependencies: { 'bad-peer': '^1.0.0' },
    plugins: {
      'bad-peer': {
        name: 'bad-peer',
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
      },
    },
  })
  const report = audit(f)
  const item = itemOf(report, 'bad-peer')
  assert.equal(item.severity, SEVERITY.BLOCK)
  const finding = item.findings.find((x) => x.code === FINDING.PEER_INCOMPATIBLE)
  assert.ok(finding, '应当有 peer-incompatible')
  assert.equal(finding.dshBuiltIn, 'covered')
  assert.equal(report.summary.blocked, 1)
})

test('peer 不兼容但有精确版本豁免 → WARN，表述为「带风险运行」', () => {
  const f = fixture({
    dependencies: { 'bad-peer': '1.0.0' },
    exemptions: { 'bad-peer@1.0.0': [RUNTIME] },
    plugins: {
      'bad-peer': { name: 'bad-peer', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } },
    },
  })
  const report = audit(f)
  assert.deepEqual(codesOf(report, 'bad-peer'), [FINDING.PEER_INCOMPATIBLE_EXEMPTED])
  assert.equal(itemOf(report, 'bad-peer').severity, SEVERITY.WARN)
})

test('豁免只对精确版本组合生效：换一个 dsh 版本就不再豁免', () => {
  const f = fixture({
    dependencies: { 'bad-peer': '1.0.0' },
    exemptions: { 'bad-peer@1.0.0': ['0.1.5'] },
    plugins: {
      'bad-peer': { name: 'bad-peer', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } },
    },
  })
  const report = audit(f)
  assert.equal(itemOf(report, 'bad-peer').severity, SEVERITY.BLOCK)
})

test('【核心增量】没有 peerDependencies、只在 dsh.engines 里声明不兼容 → dsh 查不到，本插件能查', () => {
  const f = fixture({
    dependencies: { 'declared-only': '1.0.0' },
    plugins: {
      'declared-only': { name: 'declared-only', version: '1.0.0', dsh: { engines: { dsh: '^0.1.0' } } },
    },
  })
  const report = audit(f)
  const item = itemOf(report, 'declared-only')
  const finding = item.findings.find((x) => x.code === FINDING.DECLARED_RANGE_INCOMPATIBLE)
  assert.ok(finding, '应当发现 dsh.engines 里的不兼容声明')
  assert.equal(finding.dshBuiltIn, 'not-covered')
  assert.equal(item.severity, SEVERITY.WARN)
  assert.equal(item.unverifiable, false, '声明了范围就不算「无法判定」')
})

test('三种声明位置都能识别', () => {
  const cases = [
    ['dsh.engines.dsh', { dsh: { engines: { dsh: '^0.1.0' } } }],
    ['dsh.compatibility.dsh', { dsh: { compatibility: { dsh: '^0.1.0' } } }],
    ['dshhub.compatibility.dsh', { dshhub: { compatibility: { dsh: '^0.1.0' } } }],
  ]
  for (const [label, extra] of cases) {
    const f = fixture({
      dependencies: { p: '1.0.0' },
      plugins: { p: { name: 'p', version: '1.0.0', ...extra } },
    })
    const report = audit(f)
    const found = itemOf(report, 'p').findings.find((x) => x.code === FINDING.DECLARED_RANGE_INCOMPATIBLE)
    assert.ok(found, `${label} 应被发现`)
    assert.equal(found.evidence.source, label)
  }
})

test('什么都没声明 → INFO 且标记为无法判定（dsh 同样不校验）', () => {
  const f = fixture({
    dependencies: { bare: '1.0.0' },
    plugins: { bare: { name: 'bare', version: '1.0.0' } },
  })
  const report = audit(f)
  assert.deepEqual(codesOf(report, 'bare'), [FINDING.UNVERIFIABLE])
  assert.equal(itemOf(report, 'bare').unverifiable, true)
  assert.equal(report.summary.unverifiable, 1)
})

test('装了但不在 bundles 里 → INFO，且不参与「影响运行时」的判定', () => {
  const f = fixture({
    dependencies: { idle: '1.0.0' },
    bundles: [],
    plugins: { idle: { name: 'idle', version: '1.0.0' } },
  })
  const report = audit(f)
  const item = itemOf(report, 'idle')
  assert.ok(item.findings.some((x) => x.code === FINDING.DEPENDENCY_NOT_ACTIVE))
  assert.equal(item.inBundles, false)
})

test('装了但读不到清单 → WARN manifest-missing', () => {
  const f = fixture({ dependencies: { ghost: '1.0.0' }, plugins: {} })
  const report = audit(f)
  assert.deepEqual(codesOf(report, 'ghost'), [FINDING.MANIFEST_MISSING])
  assert.equal(itemOf(report, 'ghost').severity, SEVERITY.WARN)
})

test('bundles 引用了没装的第三方包 → BLOCK bundle-unresolved', () => {
  const f = fixture({ dependencies: {}, bundles: ['ghost-plugin'] })
  const report = audit(f)
  assert.equal(itemOf(report, 'ghost-plugin').severity, SEVERITY.BLOCK)
  assert.deepEqual(codesOf(report, 'ghost-plugin'), [FINDING.BUNDLE_UNRESOLVED])
  assert.equal(report.summary.bundleIssues, 1)
})

test('dsh 安装自带的 bundle（@deepseek-ai/*）不算缺包', () => {
  const f = fixture({
    dependencies: { real: '1.0.0' },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'real'],
    plugins: { real: { name: 'real', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1' } } },
    installationOwned: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  })
  const report = audit(f)
  assert.equal(report.summary.bundleIssues, 0)
  assert.equal(itemOf(report, 'real').severity, SEVERITY.OK)
})

test('@deepseek-ai/* 的 bundle 若在 dsh 安装里也不存在 → 仍报 BLOCK', () => {
  const f = fixture({ dependencies: {}, bundles: ['@deepseek-ai/dsh-nonexistent'] })
  const report = audit(f)
  assert.equal(report.summary.bundleIssues, 1)
})

test('Node 版本不匹配 → WARN node-engine-incompatible', () => {
  const f = fixture({
    dependencies: { old: '1.0.0' },
    plugins: { old: { name: 'old', version: '1.0.0', engines: { node: '>=99' } } },
  })
  const report = audit(f, { nodeVersion: NODE })
  assert.ok(codesOf(report, 'old').includes(FINDING.NODE_ENGINE_INCOMPATIBLE))
})

test('声明范围与实际安装版本不一致 → INFO version-spec-drift', () => {
  const f = fixture({
    dependencies: { drift: '^2.0.0' },
    plugins: { drift: { name: 'drift', version: '1.0.0' } },
  })
  const report = audit(f)
  assert.ok(codesOf(report, 'drift').includes(FINDING.VERSION_SPEC_DRIFT))
})

test('运行时版本从 installAnchor 读出；没给 anchor 时不崩', () => {
  const f = fixture({ dependencies: {}, anchorVersion: '9.9.9' })
  // 不传 runtime：走「只读安装清单」的同步路径
  const withAnchor = auditProfile({ profileDir: f.profileDir, profileName: 'web', installAnchor: f.anchor })
  assert.equal(withAnchor.runtimeVersion, '9.9.9')
  // 没 anchor 时不崩，且版本为 null（而不是空串 —— 空串会被拿去比对，造成满屏误报）
  const without = auditProfile({ profileDir: f.profileDir, profileName: 'web' })
  assert.equal(without.runtimeVersion, null)
  assert.equal(without.error, undefined)
  // 优先级：显式 runtimeVersion > runtime.version > 安装清单
  assert.equal(audit(f, { runtimeVersion: '7.7.7' }).runtimeVersion, '7.7.7')
  assert.equal(audit(f).runtimeVersion, RUNTIME)
})

test('profile 不存在 → 落到 error 字段而不是抛异常', () => {
  const report = auditProfile({ profileDir: path.join(os.tmpdir(), 'definitely-missing-profile-xyz'), profileName: 'web' })
  assert.equal(report.summary.total, 0)
  assert.ok(report.error, '应当把原因写进 error')
})

test('损坏的 compatibility.json 不影响判定（豁免为空 + 记警告）', () => {
  const f = fixture({
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
  })
  fs.writeFileSync(path.join(f.profileDir, 'compatibility.json'), '{ 这不是 json')
  const report = audit(f)
  assert.equal(itemOf(report, 'bad').severity, SEVERITY.BLOCK)
  assert.deepEqual(report.exemptions, {})
})

test('resolverOf 识别各安装来源', () => {
  assert.equal(resolverOf('^1.0.0'), 'registry')
  assert.equal(resolverOf('link:D:/x/y'), 'local')
  assert.equal(resolverOf('file:../y'), 'local')
  assert.equal(resolverOf('github:u/r#abc'), 'git')
  assert.equal(resolverOf('git+https://a/b.git'), 'git')
  assert.equal(resolverOf('npm:other@1.0.0'), 'alias')
  assert.equal(resolverOf(undefined), 'unknown')
})

// ---------- 纯函数层 ----------

test('evaluateManifest 是纯函数：不读盘，只看传入的 manifest', () => {
  const r = evaluateManifest({
    name: 'p',
    manifest: { name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } },
    installedVersion: '1.0.0',
    runtimeVersion: RUNTIME,
    nodeVersion: NODE,
    inBundles: true,
  })
  assert.equal(r.severity, SEVERITY.BLOCK)
  assert.equal(r.findings[0].code, FINDING.PEER_INCOMPATIBLE)
})

test('非 dsh 的 peerDependencies 不参与判定', () => {
  const r = evaluateManifest({
    name: 'p',
    manifest: { name: 'p', version: '1.0.0', peerDependencies: { react: '^18.0.0', lodash: '^4' } },
    installedVersion: '1.0.0',
    runtimeVersion: RUNTIME,
    nodeVersion: NODE,
    inBundles: true,
  })
  // 不含任何 dsh peer，也不含声明 → 归入「无法判定」
  assert.deepEqual(r.findings.map((f) => f.code), [FINDING.UNVERIFIABLE])
})

test('workspace: 协议的 peer 恒满足（dsh 会替换成运行时版本）', () => {
  const r = evaluateManifest({
    name: 'p',
    manifest: { name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': 'workspace:^' } },
    installedVersion: '1.0.0',
    runtimeVersion: RUNTIME,
    nodeVersion: NODE,
    inBundles: true,
  })
  assert.equal(r.severity, SEVERITY.OK)
})

// ---------- 渲染层 ----------

test('renderReport 产出中文报告且包含可执行修复命令', () => {
  const f = fixture({
    dependencies: { 'bad-peer': '1.0.0' },
    plugins: { 'bad-peer': { name: 'bad-peer', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
  })
  const report = audit(f)
  const text = renderReport(report)
  assert.match(text, /DSH 插件兼容性体检报告/)
  assert.match(text, /bad-peer/)
  assert.match(text, /dsh plugin --profile web add bad-peer@latest/)
  assert.match(text, /dsh plugin --profile web remove bad-peer/)
  assert.match(text, /allow-version bad-peer@1\.0\.0 --dsh-version 0\.2\.0-rc\.2 --accept-risk/)
  assert.match(text, /dsh 内置检查：同样会发现/)
})

test('renderStartupWarning 在无问题时返回 null', () => {
  const f = fixture({
    dependencies: { good: '1.0.0' },
    plugins: { good: { name: 'good', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1' } } },
  })
  const report = audit(f)
  assert.equal(renderStartupWarning(report), null)
})

test('remediesFor 对「装了没启用」给的是启用/卸载两条路', () => {
  const item = {
    name: 'idle', installedVersion: '1.0.0', manifestName: 'idle',
    findings: [{ code: FINDING.DEPENDENCY_NOT_ACTIVE, severity: SEVERITY.INFO }],
  }
  const out = remediesFor(item, { profileName: 'web', runtimeVersion: RUNTIME })
  assert.equal(out.length, 2)
  assert.match(out[0].command, /add idle/)
  assert.match(out[1].command, /remove idle/)
})

test('运行时版本未知时不得误报不兼容（只说明「本次未判定」）', () => {
  const f = fixture({
    dependencies: { 'bad-peer': '1.0.0' },
    anchorVersion: RUNTIME,
    plugins: {
      'bad-peer': { name: 'bad-peer', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } },
    },
  })
  // 故意不给 installAnchor，也就能拿不到运行时版本
  const report = auditProfile({ profileDir: f.profileDir, profileName: 'web' })
  assert.equal(report.runtimeVersion, null)
  const item = itemOf(report, 'bad-peer')
  assert.notEqual(item.severity, SEVERITY.BLOCK, '拿空版本比出来的 BLOCK 是假阳性')
  assert.ok(codesOf(report, 'bad-peer').includes(FINDING.RUNTIME_UNKNOWN))
  // 但给上 anchor 后必须立刻恢复成 BLOCK —— 证明不是把判定关掉了
  const withAnchor = audit(f)
  assert.equal(itemOf(withAnchor, 'bad-peer').severity, SEVERITY.BLOCK)
})

// ---------- 本机真实 profile 的集成检查（不存在则跳过） ----------

test('对本机真实 profile 跑一次体检（不存在则跳过）', (t) => {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profileDir = path.join(home, 'profiles', 'web')
  if (!fs.existsSync(profileDir)) return t.skip('本机没有 web profile，跳过')

  const anchor = locateAnchor()
  const report = auditProfile({ profileDir, profileName: 'web', installAnchor: anchor })
  assert.equal(report.error, undefined, '体检自身不应出错')
  assert.ok(report.items.length > 0, '应当至少有一个依赖条目')
  if (anchor) {
    assert.equal(typeof report.runtimeVersion, 'string', '拿到 anchor 就应当读出运行时版本')
    assert.match(report.runtimeVersion, /^\d+\.\d+\.\d+/)
  }

  // 结构性自洽性：汇总数字必须与逐条明细一致
  const bySeverity = (s) => report.items.filter((i) => i.severity === s).length
  assert.equal(report.summary.blocked, bySeverity(SEVERITY.BLOCK))
  assert.equal(report.summary.warned, bySeverity(SEVERITY.WARN))
  assert.equal(report.summary.ok, bySeverity(SEVERITY.OK))
  assert.equal(report.summary.total, report.items.length)
  assert.equal(
    report.summary.problems,
    report.summary.blocked + report.summary.warned,
  )

  // 报告可渲染
  const text = renderReport(report)
  assert.match(text, /DSH 插件兼容性体检报告/)

  console.log(`  ℹ 本机 web profile：dsh ${report.runtimeVersion}，`
    + `阻断 ${report.summary.blocked}，警告 ${report.summary.warned}，`
    + `提示 ${report.summary.info}，通过 ${report.summary.ok}`)
  for (const item of report.items.filter((i) => i.severity !== SEVERITY.OK)) {
    console.log(`    [${item.severity}] ${item.name}@${item.installedVersion ?? '?'} — `
      + item.findings.map((x) => x.title).join('；'))
  }
})

// ===========================================================================
// 自适应：标签与后果描述必须跟着「实测到的本机 dsh 能力」走
// ===========================================================================

test('【自适应核心】dsh 哪天补上盲区，标签自动从「不会发现」变成「同样会发现」', () => {
  const spec = {
    dependencies: { old: '1.0.0' },
    plugins: {
      // 没有 peer，只在非标准位置声明了 dsh 版本要求 —— 正是 dsh 当前的盲区
      old: { name: 'old', version: '1.0.0', dsh: { engines: { dsh: '>=99.0.0' } } },
    },
  }
  const declaredFinding = (f) => itemOf(audit(f), 'old').findings
    .find((x) => x.code === FINDING.DECLARED_RANGE_INCOMPATIBLE)

  // ① 现状（实测 0.1.7 / 0.2.0 都是这么答的）：dsh 不看这个字段
  const today = fixture({ ...spec, runtime: { seesDeclaredRange: false } })
  assert.equal(declaredFinding(today).dshBuiltIn, 'not-covered')
  assert.match(declaredFinding(today).detail, /不会看这个字段/)

  // ② 假设 dsh 未来把盲区补上了 —— 同一个插件、同一份代码，标签与措辞自动翻转。
  //    这就是「不用每次手动更新」的机制：结论来自实测，不来自我对版本的假设。
  const future = fixture({ ...spec, runtime: { seesDeclaredRange: true } })
  assert.equal(declaredFinding(future).dshBuiltIn, 'covered')
  assert.match(declaredFinding(future).detail, /确实会.*盲区已不复存在/)
})

test('【自适应核心】没有生效预检的 dsh 上，措辞必须从「会被拒绝加载」改成「会照常加载」', () => {
  const spec = {
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
  }
  // ① 有效预检（0.1.7 / 0.2.0 实测如此）
  const effective = itemOf(audit(fixture(spec)), 'bad')
  const f1 = effective.findings.find((x) => x.code === FINDING.PEER_INCOMPATIBLE)
  assert.equal(f1.dshBuiltIn, 'covered')
  assert.match(f1.title, /启动时会被拒绝加载/)
  assert.match(f1.detail, /置为 disabled/)

  // ② 没有预检函数的版本（0.1.1 / 0.1.5 实测如此）：说「会被拒绝加载」就是假话
  const absent = itemOf(audit(fixture({
    ...spec,
    runtime: { seesPeerMismatch: false, verdict: 'absent', deniesAtStartup: false },
  })), 'bad')
  const f2 = absent.findings.find((x) => x.code === FINDING.PEER_INCOMPATIBLE)
  assert.equal(f2.dshBuiltIn, 'not-covered')
  assert.match(f2.title, /不会拦下它，会照常加载/)
  assert.match(f2.detail, /不会拦下它/)
  assert.doesNotMatch(f2.detail, /置为 disabled/)
})

test('没有豁免机制的 dsh 版本上，不给 allow-version 这条走不通的路', () => {
  const spec = {
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
  }
  const withExemption = remediesFor(itemOf(audit(fixture(spec)), 'bad'), { profileName: 'web', runtimeVersion: RUNTIME, builtIn: fakeRuntime().builtIn })
  assert.ok(withExemption.some((r) => r.command.includes('allow-version')))

  const noMechanism = fixture({ ...spec, runtime: { exemptionMechanism: false, version: '0.1.5-rc.3' } })
  const r = remediesFor(itemOf(audit(noMechanism), 'bad'), {
    profileName: 'web', runtimeVersion: '0.1.5-rc.3', builtIn: noMechanism.runtime.builtIn,
  })
  assert.ok(!r.some((x) => x.command.includes('allow-version')), '不该给出走不通的豁免命令')
})

// ===========================================================================
// compatibility.json 的**真实**格式（这里踩过一个大坑）
// ===========================================================================

test('豁免文件是裸的豁免表（真实格式）→ 识别为「带风险运行」而不是阻断', () => {
  const f = fixture({
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
    // 真实文件内容就是这一层，dsh 的写入端是 JSON.stringify(exemptions)
    compatibilityRaw: { 'bad@1.0.0': [RUNTIME] },
  })
  const report = audit(f)
  assert.deepEqual(report.exemptions, { 'bad@1.0.0': [RUNTIME] })
  assert.equal(itemOf(report, 'bad').severity, SEVERITY.WARN)
  assert.ok(codesOf(report, 'bad').includes(FINDING.PEER_INCOMPATIBLE_EXEMPTED))
  assert.equal(report.profile.compatibilitySource, 'self', '没有 dsh 读取器时用自包含解析')
})

test('豁免若被包在 exemptions 字段下（错误格式）也能读到，但要给出警告', () => {
  const f = fixture({
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
    compatibilityRaw: { exemptions: { 'bad@1.0.0': [RUNTIME] } },
  })
  const report = audit(f)
  assert.deepEqual(report.exemptions, { 'bad@1.0.0': [RUNTIME] }, '容错读取')
  assert.equal(itemOf(report, 'bad').severity, SEVERITY.WARN)
  assert.ok(report.profile.compatibilityWarnings.some((w) => /顶层直接就是豁免表/.test(w)))
})

test('非法的豁免记录逐条跳过并说明原因（不整份丢弃，也不静默）', () => {
  const f = fixture({
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
    compatibilityRaw: {
      'bad@1.0.0': 'not-a-list',          // 值必须是数组
      'not-a-key': [RUNTIME],             // 键必须含 @
      'bad@^1.0.0': [RUNTIME],            // 版本必须是精确版本，不能是范围
      'other@2.0.0': ['not-a-version'],   // 值必须是精确版本
    },
  })
  const report = audit(f)
  assert.deepEqual(report.exemptions, {})
  assert.equal(report.profile.compatibilityWarnings.length, 4)
  assert.equal(itemOf(report, 'bad').severity, SEVERITY.BLOCK, '没有有效豁免 → 仍然是阻断')
})

// ===========================================================================
// 没能实测时：不下断言
// ===========================================================================

test('未做能力探测时，标签是「未实测」而不是替 dsh 打包票', () => {
  const f = fixture({
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
  })
  // 完全不传 runtime
  const report = auditProfile({ profileDir: f.profileDir, profileName: 'web', installAnchor: f.anchor })
  const f1 = itemOf(report, 'bad').findings.find((x) => x.code === FINDING.PEER_INCOMPATIBLE)
  assert.equal(f1.dshBuiltIn, 'unknown')
  assert.match(f1.dshBuiltInSource, /未能实测/)
  assert.equal(report.adaptation.builtIn.determined, false)
  assert.equal(report.adaptation.builtIn.verdict, 'unknown')

  const text = renderReport(report)
  assert.match(text, /以下问题「dsh 自己会不会发现」本次\*\*未能实测确认\*\*/)
  assert.match(text, /适配信息（结论依据，不是假设）/)
})

test('报告里带「适配信息」，把结论依据摊开给用户看', () => {
  const f = fixture({
    dependencies: { bad: '1.0.0' },
    plugins: { bad: { name: 'bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } } },
    runtime: { version: '0.2.0-rc.2', notes: ['这是一条适配说明'] },
  })
  const text = renderReport(audit(f))
  assert.match(text, /适配信息（结论依据，不是假设）/)
  assert.match(text, /能力探测      : 成功/)
  assert.match(text, /会因 peer 不匹配拦下插件 : 会/)
  assert.match(text, /会检查没有 peer 的插件   : 不会（盲区）/)
  assert.match(text, /版本豁免机制             : 有（compatibility\.json）/)
  assert.match(text, /这是一条适配说明/)
  assert.match(text, /依据：dsh 兼容性预检（实测校准）/)
})