/**
 * 适配层（lib/adapt.js）的单元测试。
 *
 * 这一层是「插件能跟着 dsh 版本自己变」的关键，也是最容易写出隐蔽 bug 的地方
 * （比如路径拼接 —— 早期版本把 scope 拼了两遍，直接读不到文件）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  nodeModulesRootOf,
  packageDirOf,
  scopeOf,
  profileNameFromArgv,
  resolveContext,
  serviceOf,
  pickMethod,
} from '../lib/adapt.js'
import { anchorFromProcessEntry } from '../lib/locate.js'
import { syncRuntime } from '../lib/audit.js'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-adapt-'))
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

test('nodeModulesRootOf：scoped 包也能正确定位 node_modules（曾经的致命坑）', () => {
  const root = tmp()
  // scoped：<root>/node_modules/@deepseek-ai/dsh/package.json
  const scoped = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  assert.equal(nodeModulesRootOf(scoped), path.join(root, 'node_modules'))
  // 非 scoped：<root>/node_modules/dsh-compat-doctor/package.json
  const plain = path.join(root, 'node_modules', 'dsh-compat-doctor', 'package.json')
  assert.equal(nodeModulesRootOf(plain), path.join(root, 'node_modules'))
  // profile 里的插件（嵌套 node_modules）
  const nested = path.join(root, 'profiles', 'web', 'node_modules', 'dsh-cost-meter', 'package.json')
  write(nested, { name: 'dsh-cost-meter', version: '1.0.0' })
  assert.equal(nodeModulesRootOf(nested), path.join(root, 'profiles', 'web', 'node_modules'))
  // 路径里根本没有 node_modules 时不硬猜（返回 undefined，而不是编一个出来）
  assert.equal(nodeModulesRootOf(path.join(root, 'somewhere', 'package.json')), undefined)
  // 关键回归：绝不能把 scope 目录本身当成 node_modules（那会导致 @scope/@scope/...
  // 这种读不到任何文件的路径）
  assert.notEqual(nodeModulesRootOf(scoped), path.join(root, 'node_modules', '@deepseek-ai'))
})

test('packageDirOf：按包名拼出目录，scope 只出现一次；存在性由调用方检查', () => {
  const root = tmp()
  const nm = path.join(root, 'node_modules')
  write(path.join(nm, '@deepseek-ai', 'dsh-app-boot', 'package.json'), { name: '@deepseek-ai/dsh-app-boot' })
  write(path.join(nm, 'plain-pkg', 'package.json'), { name: 'plain-pkg' })

  const scoped = packageDirOf(nm, '@deepseek-ai/dsh-app-boot')
  assert.equal(scoped, path.join(nm, '@deepseek-ai', 'dsh-app-boot'))
  assert.ok(!scoped.includes(`@deepseek-ai${path.sep}@deepseek-ai`), 'scope 绝不能拼两遍')
  assert.ok(fs.existsSync(path.join(scoped, 'package.json')), '必须能真的读到清单')

  assert.equal(packageDirOf(nm, 'plain-pkg'), path.join(nm, 'plain-pkg'))
  // 不检查存在性是有意的：调用方读文件时自己处理失败，这里只负责拼路径
  assert.equal(packageDirOf(nm, '@deepseek-ai/not-there'), path.join(nm, '@deepseek-ai', 'not-there'))
  // 入参不合法时返回 undefined
  assert.equal(packageDirOf(undefined, 'x'), undefined)
  assert.equal(packageDirOf(nm, ''), undefined)
  assert.equal(packageDirOf(nm, undefined), undefined)
})

test('scopeOf：取出包名里的 scope，没有 scope 时返回 undefined', () => {
  assert.equal(scopeOf('@deepseek-ai/dsh-app-boot'), '@deepseek-ai')
  assert.equal(scopeOf('dsh-compat-doctor'), undefined)
  assert.equal(scopeOf(undefined), undefined)
})

test('resolveContext：config > ctx.profileContext > 环境变量 > 默认', () => {
  // anchor 会做存在性校验（拒绝不存在的路径 —— 这是有意的，免得拿错对象去探测），
  // 所以这里要造真实文件
  const root = tmp()
  const envAnchor = path.join(root, 'env-anchor.json')
  const ctxAnchor = path.join(root, 'ctx-anchor.json')
  const cfgAnchor = path.join(root, 'cfg-anchor.json')
  for (const [file, version] of [[envAnchor, '1.0.0'], [ctxAnchor, '2.0.0'], [cfgAnchor, '3.0.0']]) {
    write(file, { name: '@deepseek-ai/dsh', version })
  }

  const env = {
    DSH_HOME: path.join(root, 'env-home'),
    DSH_PROFILE: 'envprofile',
    DSH_PROFILE_DIR: path.join(root, 'env-home', 'profiles', 'envprofile'),
    DSH_INSTALL_ANCHOR: envAnchor,
  }
  const ctx = {
    profileContext: {
      name: 'ctxprofile',
      dir: path.join(root, 'ctx-dir'),
      installAnchor: ctxAnchor,
    },
  }

  // ① 只有 env → 用 env
  const a = resolveContext({ ctx: {}, env })
  assert.equal(a.profileName, 'envprofile')
  assert.equal(a.home, path.join(root, 'env-home'))
  assert.equal(a.profileDir, path.join(root, 'env-home', 'profiles', 'envprofile'))
  assert.equal(a.installAnchor, path.resolve(envAnchor))
  assert.match(a.sources.profileName, /DSH_PROFILE/)
  assert.match(a.sources.installAnchor, /DSH_INSTALL_ANCHOR/)

  // ② 加上 ctx → ctx 优先
  const b = resolveContext({ ctx, env })
  assert.equal(b.profileName, 'ctxprofile')
  assert.equal(b.profileDir, path.join(root, 'ctx-dir'))
  assert.equal(b.installAnchor, path.resolve(ctxAnchor))
  assert.match(b.sources.profileDir, /profileContext/)

  // ③ 加上 config → config 最优先（用户显式写下的选择）
  const c = resolveContext({
    ctx,
    env,
    config: {
      profileName: 'cfgprofile',
      profileDir: path.join(root, 'cfg-dir'),
      home: path.join(root, 'cfg-home'),
      installAnchor: cfgAnchor,
    },
  })
  assert.equal(c.profileName, 'cfgprofile')
  assert.equal(c.profileDir, path.join(root, 'cfg-dir'))
  assert.equal(c.home, path.join(root, 'cfg-home'))
  assert.equal(c.installAnchor, path.resolve(cfgAnchor))
  assert.match(c.sources.profileDir, /config/)

  // ④ 「配的 anchor」与「正在运行的 dsh」不一致时，必须留下冲突标记 ——
  //    否则会拿另一个 dsh 的能力去判定，还自以为做过实测校准。
  //    注意：env 与 ctx 不一致不算冲突（ctx 本来就优先于 env，选中的就是运行时事实）；
  //    真正会出问题的是 **config 覆盖了 ctx**。
  assert.equal(a.sources.installAnchorConflict, undefined, '没有运行时事实时不该报冲突')
  assert.equal(b.sources.installAnchorConflict, undefined, 'ctx 优先于 env，选中的即运行时事实')
  assert.ok(c.sources.installAnchorConflict, 'config 覆盖 ctx 时必须报冲突')
  assert.match(c.sources.installAnchorConflict, /ctx-anchor/)
})

test('resolveContext：不存在的 anchor 路径会被拒绝，改为自动定位（不拿错对象去探测）', () => {
  const r = resolveContext({
    ctx: {},
    env: { DSH_INSTALL_ANCHOR: path.join(os.tmpdir(), 'no-such-dsh-xyz', 'package.json') },
  })
  // 关键：绝不能原样返回那个不存在的路径
  assert.notEqual(r.installAnchor, path.join(os.tmpdir(), 'no-such-dsh-xyz', 'package.json'))
  assert.match(r.sources.installAnchor, /无路径无效|路径无效|自动定位|未找到/)
})

test('resolveContext：ctx.profileContext 读属性会抛时也不能失能（dsh 0.1.5 真机踩到的坑）', () => {
  // cordis 在没有 inject 该服务时，读属性直接抛：
  //   Error: cannot get property "profileContext" without inject
  // 我们用 `ctx?.profileContext` 时，这一下会炸掉整个启动自检，
  // 表现为「插件在那个 dsh 版本上什么都不做」—— 而且被 apply 的兜底吞掉、不报错，
  // 属于最难发现的一类失效。这条用例就是它的回归护栏。
  const throwing = new Proxy({}, {
    get(_target, property) {
      if (property === 'then' || typeof property === 'symbol') return undefined
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
    has() { return false },
  })

  const r = resolveContext({
    ctx: throwing,
    env: { DSH_HOME: path.join(os.tmpdir(), 'x'), DSH_PROFILE: 'web' },
  })
  assert.equal(r.profileName, 'web', '读属性抛异常时应当退回环境变量，而不是整个失能')
  assert.equal(r.profileDir, path.join(os.tmpdir(), 'x', 'profiles', 'web'))
  assert.equal(r.profileContext, undefined)

  // ctx.get 抛异常（另一种 cordis 行为）同样不能让整条链路死掉
  const getThrows = { get() { throw new Error('service registry exploded') } }
  const r2 = resolveContext({ ctx: getThrows, env: { DSH_PROFILE: 'fallback' } })
  assert.equal(r2.profileName, 'fallback')
})

test('resolveContext：显式的 --home/--profile 必须压过环境里的 DSH_PROFILE_DIR', () => {
  // 真机踩到：`dsh-compat-doctor --profile doctorcheck --home X` 被无视，
  // 因为环境里 DSH_PROFILE_DIR 指向另一个 profile，而它排在「按 home 推导」前面。
  // 命令行是显式选择，不该输给环境变量。
  const explicit = resolveContext({
    ctx: {},
    env: { DSH_HOME: 'C:\\env-home', DSH_PROFILE: 'web', DSH_PROFILE_DIR: 'C:\\env-home\\profiles\\web' },
    config: { home: 'C:\\my-home', profileName: 'doctorcheck' },
  })
  assert.equal(explicit.profileDir, path.join('C:\\my-home', 'profiles', 'doctorcheck'))
  assert.match(explicit.sources.profileDir, /推导自/)

  // 只给 --profile 时同理
  const byName = resolveContext({
    ctx: {},
    env: { DSH_HOME: 'C:\\env-home', DSH_PROFILE: 'web', DSH_PROFILE_DIR: 'C:\\env-home\\profiles\\web' },
    config: { profileName: 'doctorcheck' },
  })
  assert.equal(byName.profileDir, path.join('C:\\env-home', 'profiles', 'doctorcheck'))

  // 用户什么都没显式给 → 环境变量说话（这是 dsh 自己设的，最贴近运行时事实）
  const ambient = resolveContext({
    ctx: {},
    env: { DSH_HOME: 'C:\\env-home', DSH_PROFILE: 'web', DSH_PROFILE_DIR: 'C:\\env-home\\profiles\\web' },
    config: {},
  })
  assert.equal(ambient.profileDir, 'C:\\env-home\\profiles\\web')
  assert.match(ambient.sources.profileDir, /DSH_PROFILE_DIR/)

  // 直接给 profileDir 的优先级最高
  const direct = resolveContext({ ctx: {}, env: {}, config: { profileDir: 'D:\\direct' } })
  assert.equal(direct.profileDir, 'D:\\direct')
})

test('profileNameFromArgv：只认正在运行的 dsh 的命令行，且能识破各种写法', () => {
  // 为了同时验证「必须真的是 dsh 进程」这道闸门，这里现场搭一个最小 dsh 安装体
  // （闸门靠 argv[1] 能否反推出 dsh 的 package.json 来判断，假路径是过不去的）
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-argv-'))
  const pkgDir = path.join(fakeHome, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }))
  const bin = path.join(pkgDir, 'lib', 'bin.js')
  fs.writeFileSync(bin, '')

  try {
    // 不是 dsh 进程 → 一律不解析（免得把别的程序的参数当 profile 名）
    assert.equal(profileNameFromArgv(['node', 'D:\\some\\script.mjs', '--profile', 'evil']), undefined)

    // 各种 dsh 写法
    assert.equal(profileNameFromArgv(['node', bin, '--profile', 'tui']), 'tui')
    assert.equal(profileNameFromArgv(['node', bin, '--profile=tui']), 'tui')
    assert.equal(profileNameFromArgv(['node', bin, 'web']), 'web')
    assert.equal(profileNameFromArgv(['node', bin, '--no-open', 'web']), 'web')
    // 位置式写法要跳过开关的取值
    assert.equal(profileNameFromArgv(['node', bin, '--patch', './x.yml', 'tui']), 'tui')
    assert.equal(profileNameFromArgv(['node', bin, '--profile', 'doctorcheck', 'hi']), 'doctorcheck')
    assert.equal(profileNameFromArgv(['node', bin, '--from-default-profile', 'headless', 'doctorcheck']), 'doctorcheck')
    // pnpm 直通命令不启动 profile
    assert.equal(profileNameFromArgv(['node', bin, 'plugin', '--profile', 'web', 'add', 'x']), undefined)
    // 什么都不给
    assert.equal(profileNameFromArgv(['node', bin]), undefined)
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('anchorFromProcessEntry：正在运行的 dsh 优先，普通脚本不误报', () => {
  // 这条是「实测校准」的可信度前提：PATH 上可能有好几个 dsh，
  // 从进程入口反推才不会把「正在跑的这个」认成别人。
  const old = 'C:\\cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
  if (fs.existsSync(old)) {
    const got = anchorFromProcessEntry(['node', old])
    assert.ok(got && got.includes('1e7f6d9597241db0'), '应当从入口反推出真正在跑的那个 dsh')
    assert.equal(profileNameFromArgv(['node', old, '--profile', 'tui']), 'tui')
  }
  assert.equal(anchorFromProcessEntry(['node', 'D:\\tmp\\whatever.mjs']), undefined)
})

test('resolveContext：全空环境也能推导出可用位置（不返回 undefined 让人踩）', () => {
  const r = resolveContext({ ctx: {}, env: {}, config: {} })
  assert.equal(r.profileName, 'web', '默认 profile 名')
  assert.equal(r.home, path.join(os.homedir(), '.dsh'), '默认 home')
  assert.equal(r.profileDir, path.join(os.homedir(), '.dsh', 'profiles', 'web'))
  // anchor 允许探测不到，但必须是 null 或真实路径，不能是空串
  assert.ok(r.installAnchor === null || typeof r.installAnchor === 'string')
  assert.ok(r.sources && typeof r.sources === 'object')
})

test('resolveContext：DSH_PROFILE_DIR 优先于 home+名字 的推导', () => {
  const r = resolveContext({
    ctx: {},
    env: { DSH_HOME: 'C:\\h', DSH_PROFILE: 'web', DSH_PROFILE_DIR: 'D:\\custom\\profiles\\web' },
  })
  assert.equal(r.profileDir, 'D:\\custom\\profiles\\web')
  assert.match(r.sources.profileDir, /DSH_PROFILE_DIR/)
})

test('serviceOf：ctx.get 优先，其次 ctx[name]，最后 ctx.root[name]；异常不外泄', () => {
  const tools = { register() {} }
  assert.equal(serviceOf({ get: () => tools }, 'tools'), tools, 'ctx.get 优先')
  assert.equal(serviceOf({ tools }, 'tools'), tools, 'ctx[name] 兜底')
  assert.equal(serviceOf({ root: { tools } }, 'tools'), tools, 'ctx.root[name] 兜底')
  assert.equal(serviceOf({}, 'tools'), undefined, '都没有时返回 undefined')
  assert.equal(serviceOf({ get: () => { throw new Error('boom') } }, 'tools'), undefined, 'get 抛异常要吞掉')
  assert.equal(serviceOf(null, 'tools'), undefined, 'ctx 为 null 也不炸')
})

test('pickMethod：按候选名取第一个可用方法；没有就返回 undefined', () => {
  assert.equal(pickMethod({ register() {} }, ['register', 'define']).name, 'register')
  assert.equal(pickMethod({ define() {} }, ['register', 'define']).name, 'define')
  // 非函数的值要跳过，不能被 typeof 骗过去
  assert.equal(pickMethod({ register: 'not-a-function' }, ['register']), undefined)
  assert.equal(pickMethod({}, ['register']), undefined)
  assert.equal(pickMethod(null, ['register']), undefined)
  // 返回的是**绑定到原对象**的函数：注册方法用 this 时不能丢上下文
  const target = { register(argument) { return { self: this, argument } } }
  const picked = pickMethod(target, ['register'])
  assert.equal(picked.fn('a').self, target)
  assert.equal(picked.fn('a').argument, 'a')
})

test('syncRuntime：同步兜底描述读得到版本，但绝不谎称做过能力探测', () => {
  const root = tmp()
  const anchor = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  write(anchor, { name: '@deepseek-ai/dsh', version: '9.9.9-test' })

  const r = syncRuntime(anchor)
  assert.equal(r.version, '9.9.9-test')
  assert.equal(r.found, true)
  assert.equal(r.builtIn.determined, false, '没做探测就不能说 determined')
  assert.equal(r.builtIn.verdict, 'unknown')
  assert.equal(r.builtIn.deniesAtStartup, undefined, '不知道就别猜')
  assert.ok(r.appBoot.reason, '要说明为什么没探到')
  assert.equal(r.nodeModulesRoot, path.join(root, 'node_modules'))

  // 拿不到 anchor 时不崩，如实说没有
  const none = syncRuntime(null)
  assert.equal(none.found, false)
  assert.equal(none.builtIn.determined, false)
})
