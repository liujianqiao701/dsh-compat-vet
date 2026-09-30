/**
 * 自适应层：把「本机装的是哪个 dsh、它有哪些能力」探出来，而不是假设。
 *
 * 为什么不能靠版本号判断 —— 实测四个真实 dsh 版本（本机 npx 缓存里就有）：
 *
 *   dsh 版本      兼容性预检 evaluatePluginCompatibility   豁免机制 compatibility.json
 *   0.1.1-rc.2    不存在                                    不存在
 *   0.1.5-rc.3    不存在                                    不存在
 *   0.1.7-rc.1    存在，判定正确                             存在
 *   0.2.0-rc.2    存在，判定正确                             存在
 *
 * 光看「有没有」还不够：预检函数「存在但行为变了」是完全可能的，而这种变化
 * 版本号里读不出来。所以本模块对预检函数**做实测校准** —— 拿几个与版本无关的
 * 合成清单去问它，看它到底会不会报。结论来自实测，不来自我的假设。
 *
 * 校准清单必须与版本无关：早期我用 `^0.1.0-rc.6` 当「坏范围」，结果它对
 * 0.1.7-rc.1 是**合法满足**的，于是把一个正常工作的预检误判成「失效」。
 * 所以统一用 `>=999.0.0`（任何真实 dsh 版本都不满足）。
 *
 * 所有探测都是**可选**的：探测失败就退回自包含实现，绝不让体检本身变成故障源。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { locateAnchor, anchorFromProcessEntry } from './locate.js'

/** dsh 自带的 compat 预检所在的包名（相对于 dsh 安装根）。 */
const APP_BOOT_PACKAGE = 'dsh-app-boot'

/** 校准用的哨兵范围：任何真实 dsh 版本都不可能满足。 */
const IMPOSSIBLE_RANGE = '>=999.0.0'

/**
 * 从 `<...>/node_modules/<包>/package.json` 往上找到 `node_modules` 那一层。
 *
 * 刻意不用「dirname 固定层数」：有 scope 的包（`@scope/name`）要比无 scope 的多一层，
 * 数层数是这里最容易犯的错（本模块第一版就多数了一层，把 app-boot 找成了
 * `<root>/node_modules/@deepseek-ai/@deepseek-ai/dsh-app-boot`）。
 */
export function nodeModulesRootOf(packageJsonPath) {
  let dir = path.dirname(packageJsonPath)
  for (;;) {
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    if (path.basename(parent) === 'node_modules') return parent
    dir = parent
  }
}

/** 把包名拼成它在该 node_modules 下的目录（自动处理 scope）。 */
export function packageDirOf(nodeModulesRoot, packageName) {
  if (nodeModulesRoot === undefined || typeof packageName !== 'string' || packageName === '') return undefined
  return path.join(nodeModulesRoot, ...packageName.split('/'))
}

/** 从包名取出 scope（无 scope 返回 undefined）。 */
export function scopeOf(packageName) {
  if (typeof packageName !== 'string') return undefined
  const slash = packageName.indexOf('/')
  return slash === -1 ? undefined : packageName.slice(0, slash)
}

// ---------------------------------------------------------------------------
// 上下文解析：把 profile / dsh 安装位置找出来，并记录每一项的来源
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 把用户给的 anchor 规范成 <...>/@scope/dsh/package.json 这种文件路径。 */
function normalizeAnchor(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let candidate = value
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      candidate = path.join(candidate, 'package.json')
    }
  } catch {
    // 探测失败就当文件路径处理，交给下面的存在性检查
  }
  if (!fs.existsSync(candidate)) return undefined
  return path.resolve(candidate)
}

/**
 * 求值一个「可选」来源；它内部出错就当它没有。
 *
 * 存在的理由：这些来源都是「有更好、没有也能活」的锦上添花。任何一处抛异常，
 * 若直接冒到 `apply()`，整个启动自检就会被兜底吞掉 —— 表现成
 * 「插件在这个 dsh 版本上什么都不做」，最难发现。所以逐个降级，不许整条链路陪葬。
 */
function safe(fn) {
  try { return fn() } catch { return undefined }
}

/**
 * 从**当前进程的命令行**读出「正在启动哪个 profile」。
 *
 * 为什么需要它：dsh 0.1.1-rc.2 上根本没有 `profileContext` 服务，插件只能退回环境变量；
 * 而 `DSH_PROFILE_DIR` 是**继承**来的 —— 在一个 `web` 会话里执行
 * `dsh --profile tui`，子进程拿到的环境变量仍指向 `web`，插件就会去体检**另一个 profile**
 * 还理直气壮地报警。命令行里写着的那个才是事实。
 *
 * 只在入口脚本确实是 dsh 时才解析，免得把别的程序的参数当成 profile 名。
 *
 * @param {string[]} [argv]
 * @returns {string|undefined}
 */
export function profileNameFromArgv(argv = process.argv) {
  if (anchorFromProcessEntry(argv) === undefined) return undefined
  const args = argv.slice(2)
  // `dsh plugin ...` 是 pnpm 直通命令，不启动 profile
  if (args[0] === 'plugin') return undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--profile' && typeof args[i + 1] === 'string' && args[i + 1] !== '') return args[i + 1]
    if (typeof args[i] === 'string' && args[i].startsWith('--profile=')) {
      const value = args[i].slice('--profile='.length)
      if (value !== '') return value
    }
  }
  // `dsh web` 这种位置式写法：用法是 `dsh [--profile] <name> [options] [app-args...]`，
  // 所以第一个「不是开关、也不是开关取值」的参数就是 profile 名
  const valueFlags = new Set(['--profile', '--patch', '--from-default-profile'])
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (typeof arg !== 'string') continue
    if (arg.startsWith('-')) {
      if (valueFlags.has(arg)) i += 1 // 跳过它的取值，别把取值当 profile 名
      continue
    }
    return arg
  }
  return undefined
}

/**
 * 依次尝试多个来源找出 profile 与 dsh 安装位置。
 *
 * 来源顺序刻意是「显式配置在最前，其后是运行时事实，最后是环境变量与自动定位」：
 *   ① config（用户在 cordis.patch.yml 里显式写的 —— 有意的选择，必须尊重，
 *      也是让整条链路可测的前提）
 *   ② ctx.profileContext（dsh 正在用的那个 profile / 那个安装目录 —— 运行时事实）
 *   ③ 环境变量（DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR / …；
 *      每一轮 dsh 版本的环境变量集合都不一样，必须多路兜底）
 *   ④ 自动定位（PATH / npx 缓存 / 全局安装目录）
 *
 * 只认 ctx.profileContext 是不行的：在没有该字段的 dsh 版本上插件会静默什么都不做。
 * 但 ① 优先于 ② 有一个副作用 —— 配的 anchor 可能与**正在运行**的 dsh 不是同一个，
 * 那样「实测校准」就测错了对象。所以这里额外记一个冲突标记，由调用方提示用户。
 */
export function resolveContext({ ctx, config = {}, env = process.env } = {}) {
  // ⚠️ 必须走 serviceOf 而不是 `ctx?.profileContext`：cordis 在插件没有 inject
  // 该服务时，**读属性会直接抛** `cannot get property "profileContext" without inject`
  // （dsh 0.1.5-rc.3 实测如此）。我们刻意 inject 为空，所以这一下就会炸掉整个自检 ——
  // 表现为「插件在那个 dsh 版本上什么都不做」，而且因为 apply 有兜底还不报错，
  // 属于最难发现的一类失效。serviceOf 内部逐个 try/catch，读不到就换下一个来源。
  const profileContext = serviceOf(ctx, 'profileContext')
  const sources = {}

  const firstString = (...pairs) => {
    for (const [value, label] of pairs) {
      if (typeof value === 'string' && value.trim() !== '') return { value, label }
    }
    return { value: undefined, label: 'none' }
  }

  const home = firstString(
    [config.home, 'config.home'],
    [env.DSH_HOME, 'env.DSH_HOME'],
    [path.join(os.homedir(), '.dsh'), '默认 ~/.dsh'],
  )
  sources.home = home.label

  const profileName = firstString(
    [config.profileName, 'config.profileName'],
    [profileContext?.name, 'ctx.profileContext.name'],
    // 命令行事实优先于继承来的环境变量（见 profileNameFromArgv 的注释）
    [safe(profileNameFromArgv), 'argv（正在启动的 profile）'],
    [env.DSH_PROFILE, 'env.DSH_PROFILE'],
    ['web', '默认 web'],
  )
  sources.profileName = profileName.label

  const profilesDirName = typeof config.profilesDirName === 'string' && config.profilesDirName !== ''
    ? config.profilesDirName
    : 'profiles'

  const derivedProfileDir = home.value === undefined
    ? undefined
    : path.join(home.value, profilesDirName, profileName.value ?? 'web')
  // profile 名来自「显式指定 / 运行时事实 / 命令行」而非环境变量时，就按它推导目录，
  // **不让继承来的 DSH_PROFILE_DIR 悄悄盖掉它** —— 否则会出现
  // 「在 web 会话里 dsh --profile tui，插件却去体检 web」这种张冠李戴
  // （dsh 0.1.1-rc.2 实测踩到，那个版本没有 profileContext 可以兜底）。
  const nameIsExplicit = !profileName.label.startsWith('env.') && profileName.label !== '默认 web'

  const profileDir = firstString(
    [config.profileDir, 'config.profileDir'],
    [profileContext?.dir, 'ctx.profileContext.dir'],
    [nameIsExplicit ? derivedProfileDir : undefined, '推导自 profile 名 + home'],
    [env.DSH_PROFILE_DIR, 'env.DSH_PROFILE_DIR'],
    [derivedProfileDir, '推导自 home/profiles/name'],
  )
  sources.profileDir = profileDir.label

  const anchor = firstString(
    [config.installAnchor, 'config.installAnchor'],
    [profileContext?.installAnchor, 'ctx.profileContext.installAnchor'],
    // 这两个名字都不是 dsh 的官方变量，但用户手动指定时很有用
    [env.DSH_INSTALL_ANCHOR, 'env.DSH_INSTALL_ANCHOR'],
    [env.DSH_ANCHOR, 'env.DSH_ANCHOR'],
  )
  let anchorPath = normalizeAnchor(anchor.value)
  if (anchorPath !== undefined) {
    sources.installAnchor = anchor.label
  } else {
    const located = locateAnchor()
    anchorPath = located
    sources.installAnchor = located === undefined
      ? (anchor.value === undefined ? '未找到' : `${anchor.label}（路径无效，自动定位也没找到）`)
      : `自动定位（PATH / npx 缓存 / 全局安装目录）`
  }

  // 配的 anchor 与「正在运行的 dsh」不是同一个时，探测就会测错对象 —— 必须让用户知道
  const runtimeAnchor = normalizeAnchor(profileContext?.installAnchor)
  if (runtimeAnchor !== undefined && anchorPath !== undefined && runtimeAnchor !== anchorPath) {
    sources.installAnchorConflict = `配置/环境变量给的是 ${anchorPath}，`
      + `但当前 profile 记录的是 ${runtimeAnchor}`
  }

  return {
    home: home.value,
    profileName: profileName.value ?? 'web',
    profileDir: profileDir.value,
    installAnchor: anchorPath,
    profileContext,
    sources,
  }
}

// ---------------------------------------------------------------------------
// 运行时能力探测
// ---------------------------------------------------------------------------

/** 解析包自己的入口声明（exports 可能是字符串、对象或条件导出）。 */
function entryOf(packageDir) {
  const read = readJson(path.join(packageDir, 'package.json'))
  if (!read.ok) return { ok: false, reason: `读不到 ${path.join(packageDir, 'package.json')}` }
  const manifest = read.value
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string') candidates.push(value)
    else if (value && typeof value === 'object') {
      for (const key of ['.', 'import', 'default', 'node']) push(value[key])
    }
  }
  push(manifest.exports)
  if (typeof manifest.main === 'string') candidates.push(manifest.main)
  candidates.push('lib/index.js', 'index.js')
  for (const c of candidates) {
    const file = path.join(packageDir, c)
    if (fs.existsSync(file)) return { ok: true, file }
  }
  return { ok: false, reason: `${packageDir} 里找不到入口文件` }
}

// 同一个 anchor 只导入一次（探测有 IO 与解析成本，且体检可能被反复调用）
const importCache = new Map()

async function loadAppBoot(anchor, packageName) {
  const nodeModulesRoot = nodeModulesRootOf(anchor)
  const scope = scopeOf(packageName)
  const appBootName = scope === undefined ? APP_BOOT_PACKAGE : `${scope}/${APP_BOOT_PACKAGE}`
  const packageDir = packageDirOf(nodeModulesRoot, appBootName)
  const key = `${anchor}::${appBootName}`
  if (importCache.has(key)) return importCache.get(key)

  if (packageDir === undefined) {
    const result = { ok: false, reason: `无法从 ${anchor} 推导出 node_modules 根` }
    importCache.set(key, result)
    return result
  }

  const entry = entryOf(packageDir)
  if (!entry.ok) {
    const result = { ok: false, reason: entry.reason, packageDir }
    importCache.set(key, result)
    return result
  }
  let result
  try {
    const mod = await import(pathToFileURL(entry.file).href)
    result = { ok: true, module: mod, packageDir, entry: entry.file }
  } catch (error) {
    result = { ok: false, reason: `导入失败：${String(error?.message ?? error)}`, packageDir, entry: entry.file }
  }
  importCache.set(key, result)
  return result
}

/**
 * 对 dsh 自己的预检函数做实测校准。
 *
 * 返回的是「实测行为」而不是「应当的行为」：
 *  - seesPeerMismatch   ：peer 与运行时不匹配时会不会报出来（决定插件是否会被拒绝加载）
 *  - seesPeerlessPlugin ：插件完全没有 peerDependencies 时会不会报（dsh 的已知盲区）
 *  - seesDeclaredRange  ：只看 dsh.engines / dsh.compatibility 这类**非** peer 声明时会不会报
 */
function calibrateChecker(evaluate, runtimeVersion) {
  const base = { name: '@dsh-compat-vet/calibration', version: '0.0.0' }
  const probes = {
    peerMismatch: { ...base, peerDependencies: { '@deepseek-ai/dsh': IMPOSSIBLE_RANGE } },
    peerMatch: { ...base, peerDependencies: { '@deepseek-ai/dsh': '*' } },
    peerless: { ...base },
    declaredOnly: {
      ...base,
      dsh: { engines: { dsh: IMPOSSIBLE_RANGE } },
      dshhub: { compatibility: { dsh: IMPOSSIBLE_RANGE } },
    },
  }
  const flagged = {}
  const errors = {}
  for (const [label, manifest] of Object.entries(probes)) {
    try {
      flagged[label] = evaluate(manifest, {}, runtimeVersion) !== undefined
    } catch (error) {
      flagged[label] = false
      errors[label] = String(error?.message ?? error)
    }
  }
  return {
    seesPeerMismatch: flagged.peerMismatch === true && flagged.peerMatch === false,
    seesPeerlessPlugin: flagged.peerless === true,
    seesDeclaredRange: flagged.declaredOnly === true,
    peerMatchFlagged: flagged.peerMatch === true,
    errors,
    probesUsed: probes,
  }
}

/**
 * 探测本机 dsh 的版本与能力。
 *
 * 结果里的 `builtIn` 是**结论级**信息：它决定报告里哪些问题标「dsh 自己也会发现」、
 * 以及「不兼容的插件会不会被拒绝加载」这段后果描述该怎么说。
 */
export async function probeRuntime({ installAnchor, profileDir, profileName } = {}) {
  const notes = []
  const runtime = {
    anchor: installAnchor,
    found: false,
    version: undefined,
    versionSource: 'unknown',
    packageName: undefined,
    scope: undefined,
    nodeModulesRoot: installAnchor === undefined ? undefined : nodeModulesRootOf(installAnchor),
    appBoot: { loaded: false, reason: installAnchor === undefined ? '没有 dsh 安装位置' : undefined },
    profilesDirName: 'profiles',
    patchFilename: 'cordis.patch.yml',
    compatibilityFilename: 'compatibility.json',
    compatibilitySupported: false,
    defaultBundles: [],
    optionalBundles: [],
    readers: { exemptions: undefined, compatibility: undefined },
    checker: undefined,
    builtIn: {
      verdict: 'unknown',
      // determined = 「本机 dsh 的行为到底怎样」有没有被实测出来。
      // 探测失败时它是 false，此时所有标签都是 unknown —— 不替 dsh 打包票。
      determined: false,
      calibrated: false,
      seesPeerMismatch: false,
      seesPeerlessPlugin: false,
      seesDeclaredRange: false,
      deniesAtStartup: undefined,
      exemptionMechanism: false,
    },
    notes,
  }

  if (installAnchor === undefined) {
    notes.push('没有定位到 dsh 安装目录，版本相关的判定本次跳过。')
    return runtime
  }
  const manifest = readJson(installAnchor)
  if (!manifest.ok) {
    notes.push(`读不到 ${installAnchor}（${manifest.error}），版本相关的判定本次跳过。`)
    return runtime
  }
  runtime.found = true
  runtime.packageName = typeof manifest.value?.name === 'string' ? manifest.value.name : undefined
  runtime.version = typeof manifest.value?.version === 'string' ? manifest.value.version : undefined
  runtime.versionSource = 'anchor-manifest'
  runtime.scope = scopeOf(runtime.packageName)

  const boot = await loadAppBoot(installAnchor, runtime.packageName)
  if (!boot.ok) {
    runtime.appBoot.reason = boot.reason
    notes.push(`探测 dsh 自身能力失败（${boot.reason}），已退回自包含实现：`
      + '版本号仍然可用，但「dsh 自己会不会发现这些问题」无法实测，只能按保守假设标注。')
    return runtime
  }

  const m = boot.module
  runtime.appBoot = { loaded: true, entry: boot.entry }
  const has = (key) => Object.hasOwn(m, key) && m[key] !== undefined

  if (has('PROFILES_DIR') && typeof m.PROFILES_DIR === 'string') {
    runtime.profilesDirName = m.PROFILES_DIR
  }
  if (has('PROFILE_PATCH_FILENAME') && typeof m.PROFILE_PATCH_FILENAME === 'string') {
    runtime.patchFilename = m.PROFILE_PATCH_FILENAME
  }
  if (has('PROFILE_COMPATIBILITY_FILENAME') && typeof m.PROFILE_COMPATIBILITY_FILENAME === 'string') {
    runtime.compatibilityFilename = m.PROFILE_COMPATIBILITY_FILENAME
    runtime.compatibilitySupported = true
  }
  if (Array.isArray(m.DEFAULT_PROFILE_BUNDLES)) runtime.defaultBundles = m.DEFAULT_PROFILE_BUNDLES.filter((v) => typeof v === 'string')
  if (Array.isArray(m.OPTIONAL_BUNDLES)) runtime.optionalBundles = m.OPTIONAL_BUNDLES.filter((v) => typeof v === 'string')

  if (typeof m.readProfileVersionExemptions === 'function') runtime.readers.exemptions = m.readProfileVersionExemptions
  if (typeof m.readProfileCompatibility === 'function') runtime.readers.compatibility = m.readProfileCompatibility

  if (typeof m.getDshRuntimeVersion === 'function') {
    try {
      const v = m.getDshRuntimeVersion()
      if (typeof v === 'string' && v !== '' && v !== runtime.version) {
        notes.push(`dsh 自报版本 ${v}，安装清单写的是 ${runtime.version}，以 dsh 自报为准。`)
        runtime.version = v
        runtime.versionSource = 'getDshRuntimeVersion()'
      } else if (typeof v === 'string' && v !== '') {
        runtime.versionSource = 'getDshRuntimeVersion()（与安装清单一致）'
      }
    } catch (error) {
      notes.push(`调用 getDshRuntimeVersion() 失败：${String(error?.message ?? error)}`)
    }
  }

  // 预检函数不存在 → 这个版本根本没有兼容性预检（实测 0.1.1 / 0.1.5 就是如此）
  if (typeof m.evaluatePluginCompatibility !== 'function') {
    runtime.builtIn.verdict = 'absent'
    // 「这个版本没有这个检查」同样是**实测**出来的结论（导出里确实没有），
    // 所以 determined 为 true，标签可以放心写 not-covered
    runtime.builtIn.determined = true
    runtime.builtIn.deniesAtStartup = false
    runtime.builtIn.exemptionMechanism = runtime.compatibilitySupported
    notes.push('本机 dsh 没有兼容性预检函数 —— 它**不会**因为 peer 不匹配而拒绝加载任何插件，'
      + '版本冲突会直接暴露在运行时。')
  } else {
    runtime.checker = m.evaluatePluginCompatibility
    const calibration = calibrateChecker(m.evaluatePluginCompatibility, runtime.version)
    runtime.calibration = calibration
    if (Object.keys(calibration.errors).length > 0) {
      notes.push(`校准预检函数时有探测项抛错：${JSON.stringify(calibration.errors)}`)
    }
    runtime.builtIn.calibrated = true
    runtime.builtIn.determined = true
    runtime.builtIn.seesPeerMismatch = calibration.seesPeerMismatch
    runtime.builtIn.seesPeerlessPlugin = calibration.seesPeerlessPlugin
    runtime.builtIn.seesDeclaredRange = calibration.seesDeclaredRange
    runtime.builtIn.deniesAtStartup = calibration.seesPeerMismatch
    runtime.builtIn.exemptionMechanism = runtime.compatibilitySupported
      || typeof m.readProfileVersionExemptions === 'function'
    runtime.builtIn.verdict = calibration.seesPeerMismatch
      ? 'effective'
      : (calibration.peerMatchFlagged ? 'over-eager' : 'inert')
    if (runtime.builtIn.verdict === 'inert') {
      notes.push('本机 dsh 的兼容性预检**存在但实测不报任何问题**（连明显不兼容的 peer 也放行）—— '
        + '因此「会被拒绝加载」这个后果在本机不成立。')
    } else if (runtime.builtIn.verdict === 'over-eager') {
      notes.push('本机 dsh 的兼容性预检实测连**完全兼容**的 peer 也报 —— 判定可能偏严，'
        + '请以 dsh 启动时的实际日志为准。')
    }
  }

  if (!runtime.builtIn.exemptionMechanism) {
    notes.push('本机 dsh 没有版本豁免机制（无 compatibility 文件常量），`allow-version` 这条路不适用。')
  }
  return runtime
}

// ---------------------------------------------------------------------------
// 服务获取：不同 cordis 版本取服务的方式不一样，全部试一遍
// ---------------------------------------------------------------------------

/**
 * 机会性获取 cordis 服务。
 *
 * 刻意不写进 `inject`：本插件的价值在于「环境不全时也能跑」，把服务声明成硬依赖
 * 会让它在缺服务的环境里连带不加载，那正好失去了体检的意义。
 */
export function serviceOf(ctx, name) {
  const attempts = [
    () => (typeof ctx?.get === 'function' ? ctx.get(name) : undefined),
    () => ctx?.[name],
    () => ctx?.root?.[name],
  ]
  for (const attempt of attempts) {
    try {
      const service = attempt()
      if (service !== undefined && service !== null) return service
    } catch {
      // 这个来源不可用，换下一个
    }
  }
  return undefined
}

/** 在对象上找到第一个可用的方法名（用于跨版本 API 迁移）。 */
export function pickMethod(target, names) {
  if (target === undefined || target === null) return undefined
  for (const name of names) {
    if (typeof target[name] === 'function') return { name, fn: target[name].bind(target) }
  }
  return undefined
}
