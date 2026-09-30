/**
 * 宿主插件本体的测试。
 *
 * 两条红线：
 *   ① **体检工具不能自己成为故障源** —— 各种残缺/异常的 cordis 上下文下 apply() 都不许抛；
 *   ② **适配任意 dsh 版本** —— 服务获取、工具注册、后果描述都要跟着探测结果走。
 *
 * 测试一律显式传 config（profileDir / installAnchor / runtime），
 * 这样用例既不依赖本机装了什么 dsh，也不依赖进程环境变量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, name, inject } from '../lib/index.js'

const RUNTIME = '0.2.0-rc.2'

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/** 等价于 dsh 0.2.0-rc.2 的实测能力：peer 会拦，其余是盲区。 */
function runtime(overrides = {}) {
  return {
    anchor: undefined,
    found: true,
    version: RUNTIME,
    versionSource: '测试注入',
    packageName: '@deepseek-ai/dsh',
    scope: '@deepseek-ai',
    appBoot: { loaded: true },
    profilesDirName: 'profiles',
    patchFilename: 'cordis.patch.yml',
    compatibilityFilename: 'compatibility.json',
    compatibilitySupported: true,
    defaultBundles: ['@deepseek-ai/dsh-base'],
    optionalBundles: [],
    readers: {},
    builtIn: {
      verdict: 'effective',
      determined: true,
      calibrated: true,
      seesPeerMismatch: true,
      seesPeerlessPlugin: false,
      seesDeclaredRange: false,
      deniesAtStartup: true,
      exemptionMechanism: true,
      ...(overrides.builtIn ?? {}),
    },
    notes: overrides.notes ?? [],
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'builtIn' && k !== 'notes')),
  }
}

/** 搭一个「有个坏插件」的最小 profile。 */
function badProfile({ installAnchor } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-plugin-'))
  const profileDir = path.join(root, 'profiles', 'web')
  const anchor = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  write(anchor, { name: '@deepseek-ai/dsh', version: RUNTIME })
  write(path.join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    dependencies: { 'bad-peer': '1.0.0', good: '1.0.0' },
    dsh: { profile: { bundles: ['bad-peer', 'good'] } },
  })
  write(path.join(profileDir, 'node_modules', 'bad-peer', 'package.json'), {
    name: 'bad-peer', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' },
  })
  write(path.join(profileDir, 'node_modules', 'good', 'package.json'), {
    name: 'good', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1' },
  })
  return { root, profileDir, anchor: installAnchor === undefined ? anchor : installAnchor }
}

/**
 * 会记录注册内容的假 cordis 上下文。
 * @param {object} [o]
 * @param {boolean} [o.noGet] 连 ctx.get 都没有（模拟很老的 cordis）
 * @param {boolean} [o.noTools] tools 服务不存在
 * @param {boolean} [o.noSystemPrompt] systemPrompt 服务不存在
 * @param {boolean} [o.throwOnGet] ctx.get 抛异常
 * @param {boolean} [o.alsoOnCtx] 把服务同时挂在 ctx 本身上（模拟旧 cordis 的 ctx[name] 风格）
 * @param {string} [o.toolMethod] 用哪个方法名注册工具（默认 register）
 */
function fakeCtx(o = {}) {
  const registered = { tools: [], sections: [], toolMethod: undefined, injected: [], routes: [], effects: [], disposed: 0 }
  const services = {}
  if (!o.noTools) {
    services.tools = { [o.toolMethod ?? 'register']: (d) => { registered.tools.push(d); registered.toolMethod = o.toolMethod ?? 'register' } }
  }
  if (!o.noSystemPrompt) {
    services.systemPrompt = { section: (s) => registered.sections.push(s) }
  }
  if (o.manager !== undefined) services.pluginManager = o.manager
  const ctx = {
    registered,
    ...(o.profileContext === null ? {} : { profileContext: o.profileContext }),
  }
  if (!o.noGet) {
    ctx.get = (service) => {
      if (o.throwOnGet) throw new Error('service registry exploded')
      return services[service]
    }
  }
  // 只有「没有 ctx.get 的旧 cordis」或显式要求时，才把服务挂到 ctx 本身上 ——
  // 否则就测不出「所有来源都拿不到」的分支
  if (o.noGet || o.alsoOnCtx) Object.assign(ctx, services)
  // 默认**不给** ctx.inject：模拟老 cordis，验证这条路径是安静降级而不是刷日志
  if (o.withInject === true) {
    ctx.inject = (names, callback) => {
      registered.injected.push(names)
      if (o.injectNeverCalls === true) return
      const webServer = o.webServer ?? {
        register: (route) => {
          registered.routes.push(route)
          return () => { registered.disposed += 1 }
        },
      }
      callback({
        get: (service) => services[service],
        webServer,
        effect: (fn, label) => { registered.effects.push({ fn, label }) },
      })
    }
  }
  return ctx
}

/** 临时接管 stderr 抓取诊断文本。 */
function captureStderr(fn) {
  const original = process.stderr.write
  let text = ''
  process.stderr.write = (chunk) => { text += String(chunk); return true }
  try { fn() } finally { process.stderr.write = original }
  return text
}

/** 显式传入位置的 apply 配置（不依赖任何环境变量）。 */
function configFor(f, overrides = {}) {
  return {
    profileDir: f.profileDir,
    profileName: 'web',
    installAnchor: f.anchor,
    runtime: runtime(),
    ...overrides,
  }
}

test('页面接口：有 webServer 时挂上两条 exact 路由，并用 effect 登记释放', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir }, withInject: true })
  const stderr = captureStderr(() => apply(ctx, configFor(f)))

  assert.deepEqual(ctx.registered.injected, [['webServer']], '只请求 webServer 这一个作用域')
  assert.equal(ctx.registered.routes.length, 2, '状态与修复各一条')
  assert.deepEqual(
    ctx.registered.routes.map((r) => r.path).sort(),
    ['/dsh-compat-vet/api/v1/repair', '/dsh-compat-vet/api/v1/status'],
  )
  for (const route of ctx.registered.routes) assert.equal(route.kind, 'exact')
  assert.equal(ctx.registered.effects.length, 1, '释放函数要登记进 effect，避免热重载后路由叠加')
  assert.match(ctx.registered.effects[0].label, /page routes/)

  // 释放时要逐条 dispose
  const disposer = ctx.registered.effects[0].fn()
  disposer()
  assert.equal(ctx.registered.disposed, 2)
  assert.ok(!/页面接口|ctx\.inject/.test(stderr), '挂页面接口不该额外写日志（启动告警是另一回事）')
})

test('页面接口：没有 ctx.inject（老 cordis）时**安静**跳过，不打日志', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  const stderr = captureStderr(() => apply(ctx, configFor(f)))
  assert.equal(ctx.registered.routes.length, 0)
  assert.ok(!/页面接口|ctx\.inject/.test(stderr), '拿不到 inject 不是异常，不该刷 stderr')
  assert.equal(ctx.registered.tools.length, 1, '工具与页面接口互不影响')
})

test('页面接口：pageUi=false 时完全不碰 ctx.inject', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir }, withInject: true })
  captureStderr(() => apply(ctx, configFor(f, { pageUi: false })))
  assert.deepEqual(ctx.registered.injected, [])
  assert.equal(ctx.registered.routes.length, 0)
})

test('页面接口：pluginManager 服务是**延迟**取的（apply 时还没建好也不影响）', async () => {
  const f = badProfile()
  // apply 时服务还不存在；路由挂好之后服务才出现
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir }, withInject: true })
  captureStderr(() => apply(ctx, configFor(f)))
  const route = ctx.registered.routes.find((r) => r.path.endsWith('/status'))
  assert.ok(route, '状态路由应当在')

  const response = { writeHead() {}, end(chunk) { this.body = String(chunk) } }
  await route.handler(
    Object.assign(new EventEmitter(), { method: 'GET', url: '/', headers: { host: '127.0.0.1:3080' } }),
    response,
  )
  const payload = JSON.parse(response.body)
  // 此刻仍然没有 pluginManager —— 状态里必须如实说明，而不是崩掉
  assert.equal(payload.canRepair, false)
  assert.match(payload.repairDisabledReason, /pluginManager/)
  // 关键：给出插件版本与 dsh 版本
  assert.equal(payload.dshVersion, '0.2.0-rc.2')
  assert.equal(payload.problems[0].name, 'bad-peer')
})

test('导出契约正确', () => {
  assert.equal(name, 'dsh-compat-vet')
  // 刻意不 inject：要能在基础设施不全的环境里也加载起来，靠 ctx.get() 降级
  assert.deepEqual(inject, [])
})

test('完整上下文：同步打出中文告警，并注册 1 个工具 + 1 个提示词段落', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  const stderr = captureStderr(() => apply(ctx, configFor(f)))

  assert.match(stderr, /dsh-compat-vet: 检测到 1 个插件与 dsh 0\.2\.0-rc\.2 存在兼容性问题/)
  assert.match(stderr, /bad-peer/)
  assert.equal(ctx.registered.tools.length, 1)
  assert.equal(ctx.registered.sections.length, 1)
  assert.equal(ctx.registered.toolMethod, 'register')
})

test('启动告警是**同步**打印的（dsh 挂载完就退出也不能失声）', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  let text = ''
  const original = process.stderr.write
  process.stderr.write = (chunk) => { text += String(chunk); return true }
  try {
    // 只调用同步的 apply，不做任何 await
    apply(ctx, configFor(f))
    assert.match(text, /不兼容/, 'apply 返回时就该已经写出告警，而不是等 microtask')
  } finally {
    process.stderr.write = original
  }
})

test('工具定义的形状是合法 JSON Schema（等价于 defineTool 的产物）', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  captureStderr(() => apply(ctx, configFor(f)))
  const tool = ctx.registered.tools[0]

  assert.equal(tool.name, 'plugin_compat_check')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 20)
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, [])
  assert.equal(tool.parameters.properties.includeOk.type, 'boolean')
  assert.equal(tool.output.schema.type, 'object')
  assert.deepEqual(tool.output.schema.required.sort(), ['reportJson', 'text'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.presentCall, 'function')
  assert.equal(typeof tool.presentResult, 'function')
  assert.equal(tool.isConcurrencySafe(), true)
})

test('工具的 execute 返回可渲染文本 + 可解析的 JSON 报告', async () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  captureStderr(() => apply(ctx, configFor(f)))
  const tool = ctx.registered.tools[0]

  const value = await tool.execute({})
  assert.match(value.text, /DSH 插件兼容性体检报告/)
  assert.match(value.text, /bad-peer/)
  assert.match(value.text, /适配信息（结论依据，不是假设）/)
  assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: value.text }])

  const parsed = JSON.parse(value.reportJson)
  assert.equal(parsed.schema, 'dsh-compat-vet/v1')
  assert.equal(parsed.runtimeVersion, RUNTIME)
  assert.equal(parsed.summary.blocked, 1)

  const withOk = await tool.execute({ includeOk: true })
  assert.match(withOk.text, /good/)
})

test('提示词段落：有问题给内容、无问题返回空串；措辞随实测机制变化', () => {
  const f = badProfile()
  // ① 有生效预检的版本
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  captureStderr(() => apply(ctx, configFor(f)))
  const section = ctx.registered.sections[0]
  assert.equal(section.name, 'dsh-compat-vet')
  assert.equal(typeof section.order, 'number')
  assert.equal(section.interpolate, false)
  const text = section.text({})
  assert.match(text, /DSH 插件兼容性问题/)
  assert.match(text, /bad-peer/)
  assert.match(text, /plugin_compat_check/)
  assert.match(text, /该插件已被 dsh 启动预检拒绝加载/)

  // ② 没有生效预检的版本（0.1.1 / 0.1.5 实测如此）—— 不能再说「已被拒绝加载」
  const absent = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  captureStderr(() => apply(absent, configFor(f, {
    runtime: runtime({ builtIn: { seesPeerMismatch: false, deniesAtStartup: false, verdict: 'absent', calibrated: false } }),
  })))
  const absentText = absent.registered.sections[0].text({})
  assert.match(absentText, /实测本机这个 dsh 不会拦下它/)
  assert.doesNotMatch(absentText, /已被 dsh 启动预检拒绝加载/)

  // ③ 全绿的 profile → 空串（空段落会被 dsh 丢弃，不占上下文）
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-clean-'))
  const cleanProfile = path.join(clean, 'profiles', 'web')
  write(path.join(cleanProfile, 'package.json'), {
    name: 'p', dependencies: { good: '1.0.0' }, dsh: { profile: { bundles: ['good'] } },
  })
  write(path.join(cleanProfile, 'node_modules', 'good', 'package.json'), {
    name: 'good', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1' },
  })
  const cleanCtx = fakeCtx({ profileContext: { name: 'web', dir: cleanProfile } })
  const cleanStderr = captureStderr(() => apply(cleanCtx, configFor({ ...badProfile(), profileDir: cleanProfile, anchor: f.anchor })))
  assert.equal(cleanStderr, '', '没有问题就不该刷 stderr')
  assert.equal(cleanCtx.registered.sections[0].text({}), '')
})

test('所有服务来源都拿不到时 apply 不抛，且各自给出可读诊断', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: null, noTools: true, noSystemPrompt: true })
  const stderr = captureStderr(() => assert.doesNotThrow(() => apply(ctx, configFor(f))))
  assert.equal(ctx.registered.tools.length, 0)
  assert.equal(ctx.registered.sections.length, 0)
  assert.match(stderr, /没有可用的系统提示词服务/)
  assert.match(stderr, /没有可用的注册方法/)
  // 拿不到工具不代表整体失能：启动告警照旧
  assert.match(stderr, /检测到 1 个插件与 dsh 0\.2\.0-rc\.2 存在兼容性问题/)
})

test('连 ctx.get 都没有的旧 cordis：走 ctx[name] 兜底照样注册成功', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: null, noGet: true })
  const stderr = captureStderr(() => assert.doesNotThrow(() => apply(ctx, configFor(f))))
  assert.equal(ctx.registered.tools.length, 1, 'ctx.tools 兜底应当生效')
  assert.equal(ctx.registered.sections.length, 1, 'ctx.systemPrompt 兜底应当生效')
  assert.doesNotMatch(stderr, /没有可用的/)
})

test('ctx.get 抛异常时不炸；若 ctx 上另有服务则降级使用，否则报「不可用」', () => {
  const f = badProfile()
  // ① 有兜底来源 → 降级成功，照常注册
  const degraded = fakeCtx({ profileContext: null, throwOnGet: true, alsoOnCtx: true })
  const d = captureStderr(() => assert.doesNotThrow(() => apply(degraded, configFor(f))))
  assert.equal(degraded.registered.tools.length, 1)
  assert.equal(degraded.registered.sections.length, 1)
  assert.doesNotMatch(d, /没有可用的/)

  // ② 完全没有来源 → 报「不可用」，但绝不抛
  const bare = fakeCtx({ profileContext: null, throwOnGet: true })
  const b = captureStderr(() => assert.doesNotThrow(() => apply(bare, configFor(f))))
  assert.match(b, /没有可用的系统提示词服务/)
  assert.match(b, /没有可用的注册方法/)
})

test('工具注册方法名跨版本容错：register 不存在时用 defineTool', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: null, toolMethod: 'defineTool' })
  captureStderr(() => apply(ctx, configFor(f)))
  assert.equal(ctx.registered.tools.length, 1)
  assert.equal(ctx.registered.toolMethod, 'defineTool')
})

test('profile 目录不存在时启动自检如实报「体检未完成」', () => {
  const f = badProfile()
  const stderr = captureStderr(() => apply(fakeCtx({ profileContext: null }), configFor(f, {
    profileDir: path.join(os.tmpdir(), 'definitely-missing-profile-xyz'),
  })))
  assert.match(stderr, /体检未完成/)
})

test('profile 的 package.json 损坏时启动自检如实报「未完成」', () => {
  const f = badProfile()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-broken-'))
  const profileDir = path.join(root, 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{ 坏掉的 json')
  const stderr = captureStderr(() => apply(fakeCtx({ profileContext: null }), configFor(f, { profileDir })))
  assert.match(stderr, /体检未完成/)
})

test('配置开关：warnOnStartup=false 静默、tool=false/promptSection=false 不注册', () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: f.profileDir } })
  const stderr = captureStderr(() => apply(ctx, configFor(f, {
    warnOnStartup: false, tool: false, promptSection: false,
  })))
  assert.equal(stderr, '')
  assert.equal(ctx.registered.tools.length, 0)
  assert.equal(ctx.registered.sections.length, 0)
})

test('工具在 profile 目录不可用时抛出可读错误（而不是返回空报告）', async () => {
  const f = badProfile()
  const ctx = fakeCtx({ profileContext: null })
  captureStderr(() => apply(ctx, configFor(f, {
    warnOnStartup: false,
    profileDir: path.join(os.tmpdir(), 'definitely-missing-profile-xyz'),
  })))
  const tool = ctx.registered.tools[0]
  await assert.rejects(
    () => tool.execute({}),
    /兼容性体检未能完成/,
  )
})

test('对真实 profile 跑一次 apply（本机没装 dsh/profile 则跳过）', (t) => {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profileDir = path.join(home, 'profiles', 'web')
  if (!fs.existsSync(profileDir)) return t.skip('本机没有 web profile，跳过')
  // 不传 installAnchor/runtime：走 index.js 模块加载期的真探测（含实测校准）
  const ctx = fakeCtx({ profileContext: { name: 'web', dir: profileDir } })
  const stderr = captureStderr(() => assert.doesNotThrow(() => apply(ctx, {
    profileDir, profileName: 'web', warnOnStartup: true,
  })))
  assert.equal(ctx.registered.tools.length, 1)
  assert.equal(ctx.registered.sections.length, 1)
  const text = ctx.registered.sections[0].text({})
  console.log('  ℹ 真实 profile 的启动告警：'
    + (stderr.trim() === '' ? '(无)' : `\n${stderr.trim().split('\n').map((l) => `    ${l}`).join('\n')}`))
  if (text !== '') {
    // 真探测成功时，标签与措辞必须是校准过的，而不是「未实测」
    assert.match(text, /当前 dsh 运行时为 \d+\.\d+\.\d+/)
    assert.doesNotMatch(text, /本次未能实测本机 dsh/)
  }
})
