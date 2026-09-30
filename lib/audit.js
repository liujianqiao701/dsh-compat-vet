/**
 * 插件兼容性审计引擎。
 *
 * 判定「已安装插件 × 当前 dsh 运行时」是否冲突，产出结构化报告。
 * 与 dsh 内置机制的关系（**这是本插件的价值定位**）：
 *
 *   dsh 自己只在 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 里检查
 *   **`peerDependencies` 中以 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-` 开头的键**，
 *   且一旦插件**根本没有 `peerDependencies` 字段就直接 return undefined（视为兼容）**。
 *
 *   于是以下情形 dsh 全程不看：
 *     ① `dsh.engines.dsh` / `dsh.compatibility.dsh` / `dshhub.compatibility.dsh`
 *        这些**非标准位置**的 dsh 版本要求声明（实测 `@linxin666/dsh-perf@0.3.14`
 *        声明了 `dsh.engines.dsh = ">=0.1.2-rc.1"`，却没有任何 dsh peer，dsh 侧完全没校验过它）；
 *     ② 完全没有 peerDependencies 的插件（`@liustack/modlens`、`dsh-whale-mascot`、
 *        `dsh-ask-notify` 都属于这类）；
 *     ③ bundles 列表里引用了但依赖里根本没有的包；
 *     ④ 依赖装了但没在 bundles 列表里（装了却不激活）；
 *     ⑤ profile 声明的版本范围与实际安装版本不一致；
 *     ⑥ `engines.node` 与当前 Node 不匹配。
 *
 *   每条发现都带 `dshBuiltIn` 字段说明它是 `covered`（dsh 也会发现）
 *   还是 `not-covered`（只有本插件会发现）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { satisfies, validRange, parseVersion } from './semver.js'
import { assessUpgradeRisk, needsUpgradeWarning } from './upgrade.js'
import { nodeModulesRootOf, packageDirOf, probeRuntime } from './adapt.js'

/** 严重度，从高到低。 */
export const SEVERITY = {
  /** 会被 dsh 拒绝加载 / 启动时跳过 —— 插件实际不可用。 */
  BLOCK: 'block',
  /** 能加载但契约不匹配，可能崩溃或丢数据。 */
  WARN: 'warn',
  /** 信息性提示，不一定是问题。 */
  INFO: 'info',
  /** 无发现。 */
  OK: 'ok',
}

const SEVERITY_RANK = { block: 0, warn: 1, info: 2, ok: 3 }

/** 发现类型字典（给报告和测试用稳定标识）。 */
export const FINDING = {
  PEER_INCOMPATIBLE: 'peer-incompatible',
  PEER_INCOMPATIBLE_EXEMPTED: 'peer-incompatible-exempted',
  DECLARED_RANGE_INCOMPATIBLE: 'declared-range-incompatible',
  MANIFEST_MISSING: 'manifest-missing',
  MANIFEST_UNREADABLE: 'manifest-unreadable',
  BUNDLE_UNRESOLVED: 'bundle-unresolved',
  DEPENDENCY_NOT_ACTIVE: 'dependency-not-active',
  VERSION_SPEC_DRIFT: 'version-spec-drift',
  NODE_ENGINE_INCOMPATIBLE: 'node-engine-incompatible',
  UNVERIFIABLE: 'unverifiable',
  RUNTIME_UNKNOWN: 'runtime-unknown',
  /** 「快要不适配」—— 现在能用，但下一个 dsh 版本就会失配。提示级，不是当前故障。 */
  UPGRADE_RISK: 'upgrade-risk',
}

/** 由 dsh 安装本身提供、不需要（也不应该）出现在 profile 依赖里的 bundle。 */
const INSTALLATION_OWNED_PREFIX = '@deepseek-ai/'

/** 声明的 dsh 版本要求可能出现的三个位置（实测三种都在野生插件里出现过）。 */
const DSH_RANGE_SOURCES = [
  ['dsh.engines.dsh', (m) => m?.dsh?.engines?.dsh],
  ['dsh.compatibility.dsh', (m) => m?.dsh?.compatibility?.dsh],
  ['dshhub.compatibility.dsh', (m) => m?.dshhub?.compatibility?.dsh],
]

/** 声明的 Node 版本要求可能出现的位置。 */
const NODE_RANGE_SOURCES = [
  ['engines.node', (m) => m?.engines?.node],
  ['dsh.engines.node', (m) => m?.dsh?.engines?.node],
  ['dshhub.compatibility.node', (m) => m?.dshhub?.compatibility?.node],
]

/** @returns {{ok:true,value:any}|{ok:false,error:string}} 读 JSON 且永不抛。 */
function readJsonSafe(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 从依赖 spec 推断安装来源。 */
export function resolverOf(spec) {
  if (typeof spec !== 'string') return 'unknown'
  if (spec.startsWith('link:') || spec.startsWith('file:')) return 'local'
  if (spec.startsWith('workspace:')) return 'workspace'
  if (/^(git\+|github:|gitlab:|bitbucket:)/.test(spec) || /\.git(#|$)/.test(spec)) return 'git'
  if (spec.startsWith('npm:')) return 'alias'
  if (/^https?:/.test(spec)) return 'url'
  return 'registry'
}

/** 收集一个 manifest 里所有 dsh 版本要求声明。 */
export function collectDshRanges(manifest) {
  const out = []
  for (const [source, get] of DSH_RANGE_SOURCES) {
    const range = get(manifest)
    if (typeof range === 'string' && range.trim() !== '') out.push({ source, range: range.trim() })
  }
  return out
}

/** 收集 node 版本要求声明。 */
export function collectNodeRanges(manifest) {
  const out = []
  for (const [source, get] of NODE_RANGE_SOURCES) {
    const range = get(manifest)
    if (typeof range === 'string' && range.trim() !== '') out.push({ source, range: range.trim() })
  }
  return out
}

/** 收集 dsh 相关的 peerDependencies（dsh 内置检查唯一会看的地方）。 */
export function collectDshPeers(manifest) {
  const peers = manifest?.peerDependencies
  if (!peers || typeof peers !== 'object') return {}
  const out = {}
  for (const [name, range] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range === 'string') out[name] = range
  }
  return out
}

/**
 * 发现标签的取值。
 *
 * - `covered`     ：本机 dsh 自己也会报出来（实测确认）
 * - `not-covered` ：本机 dsh 不会报（实测确认）
 * - `unknown`     ：**没能实测**，不下断言
 *
 * 注意第三种：早期版本只有前两种，于是「没定位到 dsh 安装目录」时也会硬标成
 * `not-covered` —— 那是在不知道的情况下替 dsh 打包票。宁可不说话。
 */
const BUILT_IN = { COVERED: 'covered', NOT_COVERED: 'not-covered', UNKNOWN: 'unknown' }

/** 探测失败时的保守默认值（不声称任何事）。 */
export const DEFAULT_BUILT_IN = {
  verdict: 'unknown',
  determined: false,
  calibrated: false,
  seesPeerMismatch: false,
  seesPeerlessPlugin: false,
  seesDeclaredRange: false,
  deniesAtStartup: undefined,
  exemptionMechanism: true,
}

/**
 * 某个问题类型，dsh 自己会不会发现 —— 结论来自 adapt.js 的**实测校准**，
 * 不是我对 dsh 行为的假设。
 *
 * 这是本插件能「适配任意 dsh 版本」的关键：哪天 dsh 把盲区补上了，
 * 校准会立刻测出来，标签自动从 not-covered 变成 covered，我不用改一行代码。
 */
function builtInFor(builtIn, kind) {
  const b = builtIn ?? DEFAULT_BUILT_IN
  if (!b.determined) {
    return { label: BUILT_IN.UNKNOWN, source: '未能实测（未定位到 dsh 安装目录，或能力探测失败）' }
  }
  const sees = {
    peer: b.seesPeerMismatch,
    declared: b.seesDeclaredRange,
    peerless: b.seesPeerlessPlugin,
  }[kind] === true
  const source = b.verdict === 'absent'
    ? 'dsh 兼容性预检（实测：该版本没有这个检查）'
    : (b.calibrated ? 'dsh 兼容性预检（实测校准）' : 'dsh 兼容性预检（按默认假设）')
  return { label: sees ? BUILT_IN.COVERED : BUILT_IN.NOT_COVERED, source }
}

function finding(code, severity, title, detail, dshBuiltIn, evidence = {}) {
  const label = typeof dshBuiltIn === 'string' ? dshBuiltIn : dshBuiltIn?.label
  const source = typeof dshBuiltIn === 'string' ? undefined : dshBuiltIn?.source
  return {
    code,
    severity,
    title,
    detail,
    dshBuiltIn: label ?? BUILT_IN.UNKNOWN,
    ...(source === undefined ? {} : { dshBuiltInSource: source }),
    evidence,
  }
}

/**
 * 纯函数：对单个插件 manifest 做出全部判定。
 *
 * @param {object} input
 * @param {string} input.name 依赖名（profile package.json 里的键，可能是 npm 别名）
 * @param {object|undefined} input.manifest 已解析的插件 package.json；读不到传 undefined
 * @param {string|undefined} input.manifestError 读不到时的原因
 * @param {string} input.installedVersion 实际安装版本（读不到 metadata 时是 spec）
 * @param {string} input.runtimeVersion 当前 dsh 运行时版本
 * @param {string} input.nodeVersion 当前 Node 版本（如 process.versions.node）
 * @param {Record<string,string[]>} input.exemptions compatibility.json 里的豁免
 * @param {boolean} input.inBundles 是否在 profile 的 bundles 列表里
 * @param {string|undefined} input.declaredSpec profile package.json 里的声明
 * @param {object|undefined} input.builtIn 实测校准出来的「dsh 自己会不会发现」能力集
 * @returns {{findings:object[], severity:string, unverifiable:boolean}}
 */
export function evaluateManifest(input) {
  const {
    name,
    manifest,
    manifestError,
    installedVersion,
    runtimeVersion,
    nodeVersion,
    exemptions = {},
    inBundles = false,
    declaredSpec,
    builtIn = DEFAULT_BUILT_IN,
  } = input

  const findings = []

  if (!manifest) {
    findings.push(finding(
      FINDING.MANIFEST_MISSING,
      SEVERITY.WARN,
      '读不到插件的 package.json',
      `已安装但无法解析清单，无法判断兼容性。${manifestError ? `原因：${manifestError}` : ''}`,
      BUILT_IN.NOT_COVERED,
      { probedPath: manifestError },
    ))
    return { findings, severity: SEVERITY.WARN, unverifiable: true }
  }

  const manifestName = typeof manifest.name === 'string' ? manifest.name : name
  const manifestVersion = typeof manifest.version === 'string' ? manifest.version : undefined
  const key = manifestVersion ? `${manifestName}@${manifestVersion}` : undefined

  // 运行时版本未知时**不能**做版本判定 —— 拿空串去比会把每个插件都误报成不兼容。
  // 这种情况如实说明「本次没判定」，而不是给假结论。
  const runtimeKnown = typeof runtimeVersion === 'string' && runtimeVersion !== ''

  // ---- ① dsh 内置检查会覆盖的部分：dsh 相关的 peerDependencies ----
  const peers = collectDshPeers(manifest)
  const peerIssues = {}
  for (const [peerName, range] of Object.entries(peers)) {
    if (/^workspace:/.test(range)) continue // dsh 把它替换成运行时版本后必然满足
    if (!validRange(range)) { peerIssues[peerName] = { range, reason: '范围表达式非法' }; continue }
    if (!runtimeKnown) continue
    if (!satisfies(runtimeVersion, range, { includePrerelease: true })) {
      peerIssues[peerName] = { range, reason: '不满足' }
    }
  }
  const exempted = runtimeKnown && key !== undefined
    && Array.isArray(exemptions[key])
    && exemptions[key].includes(runtimeVersion)

  if (Object.keys(peerIssues).length > 0) {
    const detail = Object.entries(peerIssues)
      .map(([k, v]) => `${k}: 声明 ${v.range}（${v.reason}）`)
      .join('；')
    const label = builtInFor(builtIn, 'peer')
    // 后果描述必须跟着**实测到的机制**走：在没有生效预检的 dsh 版本上，
    // 「会被拒绝加载」是错的 —— 它会照常加载，风险直接暴露在运行时。
    const denies = builtIn?.deniesAtStartup
    const consequence = denies === true
      ? 'dsh 启动时的兼容性预检会把该插件的加载行置为 disabled，'
        + '插件表面上还装着、实际不生效（表现为功能整块消失）。'
      : denies === false
        ? '⚠️ 本机这个 dsh **不会拦下它**：'
          + (builtIn?.verdict === 'absent'
            ? '实测该版本根本没有兼容性预检函数，'
            : '实测该版本的预检存在但不报任何问题，')
          + '所以插件会照常加载，兼容性风险直接暴露在运行时 —— '
          + '可能启动即崩，也可能跑着跑着才出错，且不会有任何拦截提示。'
        : '未能确认 dsh 这个版本会不会拦下它（没定位到 dsh 安装目录）。'
    if (exempted) {
      findings.push(finding(
        FINDING.PEER_INCOMPATIBLE_EXEMPTED,
        SEVERITY.WARN,
        '带风险运行：dsh 版本豁免已生效',
        `${detail}。运行时是 ${runtimeVersion}，但 compatibility.json 里已为 ${key} 授予精确版本豁免，`
        + '因此 dsh 仍会加载它 —— 这是「已知不兼容但选择接受风险」的状态，崩溃或数据损坏的风险依然存在。',
        label,
        { peers: peerIssues, exemption: exemptions[key] },
      ))
    } else {
      // 关键区分：**不在 dsh.profile.bundles 里的插件，dsh 根本不会加载它**。
      // 这时「启动时会被拒绝加载」这句话已经不成立，报成阻断是错的 ——
      // 既会误导用户（看起来还是很严重），也会让「隔离后复检」永远过不了。
      // 所以降为提示，并说清为什么不影响启动。
      const inactive = inBundles === false
      findings.push(finding(
        FINDING.PEER_INCOMPATIBLE,
        inactive ? SEVERITY.INFO : SEVERITY.BLOCK,
        inactive
          ? `与 dsh ${runtimeVersion} 不兼容，但它没被 dsh 加载`
          : (denies === false
            ? `与 dsh ${runtimeVersion} 不兼容（本机 dsh 不会拦下它，会照常加载）`
            : `与 dsh ${runtimeVersion} 不兼容，启动时会被拒绝加载`),
        inactive
          ? `${detail}。它不在 profile 的 \`dsh.profile.bundles\` 里，dsh **不会加载它**，`
            + '因此这不影响启动、也不会让 dsh 启动失败。等要重新启用它时再处理版本冲突。'
          : `${detail}。${consequence}`,
        label,
        { peers: peerIssues, deniesAtStartup: denies, verdict: builtIn?.verdict, ...(inactive ? { inactive: true } : {}) },
      ))
    }
  }

  // ---- ② dsh 内置检查**不看**的部分：非标准位置的 dsh 版本声明 ----
  const declared = collectDshRanges(manifest)
  const declaredLabel = builtInFor(builtIn, 'declared')
  // 「dsh 会不会看这个字段」也是实测结论，不是我的断言
  const declaredBlindness = builtIn?.determined !== true
    ? '本机 dsh 会不会校验这个字段**未能实测确认**。'
    : (builtIn.seesDeclaredRange
      ? '⚠️ 实测本机 dsh **确实会**把这类声明纳入判定（盲区已不复存在），'
        + '所以它可能也会拦下这个插件。'
      : '实测本机 dsh 的兼容性预检只查 `peerDependencies`，**不会看这个字段** —— '
        + '所以它不会拦下这个插件，却可能因为 API 变化在运行时出错。')
  for (const { source, range } of declared) {
    if (/^workspace:/.test(range)) continue
    if (!validRange(range)) {
      findings.push(finding(
        FINDING.DECLARED_RANGE_INCOMPATIBLE,
        SEVERITY.WARN,
        `${source} 的范围表达式非法`,
        `声明为 \`${range}\`，无法解析成合法 SemVer 范围。${declaredBlindness}`,
        declaredLabel,
        { source, range },
      ))
      continue
    }
    if (runtimeKnown && !satisfies(runtimeVersion, range, { includePrerelease: true })) {
      // 同上：没被加载的插件，自述版本要求不符也不影响启动，降为提示
      const inactive = inBundles === false
      findings.push(finding(
        FINDING.DECLARED_RANGE_INCOMPATIBLE,
        inactive ? SEVERITY.INFO : SEVERITY.WARN,
        inactive
          ? `自述要求 dsh ${range}，当前是 ${runtimeVersion}（但它没被 dsh 加载）`
          : `自述要求 dsh ${range}，当前是 ${runtimeVersion}`,
        `插件在 \`${source}\` 里声明了 dsh 版本要求，但**与运行时不符**。${declaredBlindness}`
        + (inactive ? '不过它不在 `dsh.profile.bundles` 里，dsh 不会加载它，所以不影响启动。' : ''),
        declaredLabel,
        { source, range, ...(inactive ? { inactive: true } : {}) },
      ))
    }
  }

  // ---- ③ Node 版本 ----
  if (typeof nodeVersion === 'string' && nodeVersion !== '') {
    for (const { source, range } of collectNodeRanges(manifest)) {
      if (/^workspace:/.test(range)) continue
      if (!validRange(range)) continue
      if (!satisfies(nodeVersion, range, { includePrerelease: true })) {
        findings.push(finding(
          FINDING.NODE_ENGINE_INCOMPATIBLE,
          SEVERITY.WARN,
          `要求 Node ${range}，当前是 ${nodeVersion}`,
          `声明位置 \`${source}\`。Node 版本不匹配可能导致语法或 API 不可用。`,
          'not-covered',
          { source, range },
        ))
      }
    }
  }

  // ---- ④ 装了但没激活 ----
  if (!inBundles) {
    findings.push(finding(
      FINDING.DEPENDENCY_NOT_ACTIVE,
      SEVERITY.INFO,
      '已安装但不在 bundles 列表里',
      '它在 profile 的 dsh.profile.bundles 中没有出现，因此不会被加载。'
      + '如果本来就想用它，把它加进 bundles；如果不用了，建议卸载以免留下过期依赖。',
      'not-covered',
      {},
    ))
  }

  // ---- ⑤ 声明范围 vs 实际安装版本 ----
  const resolver = resolverOf(declaredSpec)
  if (resolver === 'registry' && typeof declaredSpec === 'string'
      && typeof installedVersion === 'string' && installedVersion !== declaredSpec
      && validRange(declaredSpec) && parseVersion(installedVersion)) {
    if (!satisfies(installedVersion, declaredSpec, { includePrerelease: true })) {
      findings.push(finding(
        FINDING.VERSION_SPEC_DRIFT,
        SEVERITY.INFO,
        `已安装 ${installedVersion}，但 profile 声明的是 ${declaredSpec}`,
        '实际安装版本不满足 profile package.json 里写的范围（lock 与 manifest 不一致）。',
        'not-covered',
        { declaredSpec, installedVersion },
      ))
    }
  }

  // ---- ⑥ 完全无法判定 ----
  const unverifiable = Object.keys(peers).length === 0 && declared.length === 0
  if (unverifiable) {
    const peerlessLabel = builtInFor(builtIn, 'peerless')
    const peerlessDsh = builtIn?.determined !== true
      ? '本机 dsh 对它会不会做校验，本次**未能实测确认**。'
      : (builtIn.seesPeerlessPlugin
        ? '⚠️ 实测本机 dsh **会**检查这类没有 peer 声明的插件。'
        : '实测本机 dsh 对这个插件同样不做任何版本校验（只要没有 peerDependencies，它就判定为兼容）—— '
          + '这类插件升 dsh 时最需要人工回归。')
    findings.push(finding(
      FINDING.UNVERIFIABLE,
      SEVERITY.INFO,
      '没有声明任何 dsh 版本要求',
      '既没有 dsh 相关的 peerDependencies，也没有 dsh.engines/compatibility 声明，'
      + `因此**无法从元数据判断兼容性**。${peerlessDsh}`,
      peerlessLabel,
      {},
    ))
  }

  // ---- ⑦ 运行时版本未知 → 本次没做版本判定（如实说明，不给假结论） ----
  if (!runtimeKnown) {
    findings.push(finding(
      FINDING.RUNTIME_UNKNOWN,
      SEVERITY.INFO,
      '本次未判定版本兼容性',
      '没有拿到 dsh 运行时版本，所以本次**跳过了版本比对**（拿空版本去比会把所有插件都误报成不兼容）。'
      + (peers.length > 0 || declared.length > 0
        ? '该插件声明的版本要求已读出，可对照查看。'
        : '该插件也没有声明任何 dsh 版本要求。')
      + '传 --anchor <dsh 的 package.json> 或设置 DSH_INSTALL_ANCHOR 可恢复完整判定。',
      BUILT_IN.UNKNOWN,
      { peers, declared },
    ))
  }

  const severity = findings.reduce(
    (worst, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[worst] ? f.severity : worst),
    SEVERITY.OK,
  )
  return { findings, severity, unverifiable }
}
/** npm 包名规则（与 dsh 自己用的那条一致）。 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
/** 精确版本（含预发布与构建元数据），**不接受**范围、前缀、空白。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 解析 compatibility.json —— 复刻 dsh 自己的语义。
 *
 * ⚠️ 这里踩过一个大坑：文件内容是**裸的豁免表**，不是 `{exemptions: {...}}`：
 *
 *     { "dsh-cost-meter@1.7.35": ["0.2.0-rc.2"] }
 *
 * dsh 的写入端是 `JSON.stringify(exemptions)`（app-boot 的 setProfileVersionExemption），
 * `{exemptions, warnings, rewritable}` 是**读取函数的返回值**、不是文件格式。
 * 我第一版按返回值的样子去解文件，于是**真实环境里一旦授予豁免就完全读不到**，
 * 反而会把「带风险运行」误报成「阻断」—— 比不检查更糟。
 * 本函数同时容忍两种形状（写错的那种也认，并给出提示），避免再次因为格式理解错而误报。
 */
export function parseCompatibilityFile(file) {
  const read = readJsonSafe(file)
  if (!read.ok) {
    // 文件不存在是正常状态（没有授予任何豁免），不算问题
    const missing = typeof read.error === 'string' && /ENOENT/.test(read.error)
    return {
      present: !missing,
      exemptions: {},
      warnings: missing ? [] : [`${file} 无法读取（${read.error}）；按「没有任何豁免」处理`],
      rewritable: missing,
    }
  }
  let value = read.value
  const warnings = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      present: true,
      exemptions: {},
      warnings: [`${file} 必须是一个「包名@版本 → dsh 版本列表」的对象；按「没有任何豁免」处理`],
      rewritable: false,
    }
  }
  // 容忍被包了一层的形状（这是本插件早期版本的错误假设，手改的文件也可能长这样）
  if (Object.hasOwn(value, 'exemptions') && value.exemptions !== null
      && typeof value.exemptions === 'object' && !Array.isArray(value.exemptions)) {
    warnings.push(`${file} 里的豁免被包在 \`exemptions\` 字段下；`
      + 'dsh 自己的格式是**顶层直接就是豁免表**，这里已兼容读取，但建议改回 dsh 的格式')
    value = value.exemptions
  }
  const exemptions = {}
  for (const [key, versions] of Object.entries(value)) {
    const separator = key.lastIndexOf('@')
    const packageName = separator <= 0 ? '' : key.slice(0, separator)
    const version = separator <= 0 ? '' : key.slice(separator + 1)
    if (separator <= 0 || !PACKAGE_NAME.test(packageName) || !EXACT_VERSION.test(version)) {
      warnings.push(`${file}: ${JSON.stringify(key)} 不是「精确的包名@版本」键，该条豁免被忽略`)
      continue
    }
    if (!Array.isArray(versions) || !versions.every((v) => typeof v === 'string' && EXACT_VERSION.test(v))) {
      warnings.push(`${file}: ${key} 的值必须是一串精确的 dsh 版本；该条豁免被忽略`)
      continue
    }
    exemptions[key] = versions
  }
  return { present: true, exemptions, warnings, rewritable: warnings.length === 0 }
}

/** 读取 profile 的依赖、bundles 与豁免。 */
export function readProfile(profileDir, runtime) {
  const manifestRead = readJsonSafe(path.join(profileDir, 'package.json'))
  const manifest = manifestRead.ok ? manifestRead.value : undefined
  const dependencies = (manifest && typeof manifest.dependencies === 'object' && manifest.dependencies) || {}
  // bundles 的键位置跟着 dsh 版本走；dsh.profile.bundles 是实测 4 个版本都用的位置，
  // 另外两种是兜底的容错（万一将来挪位置）
  const bundlesRaw = manifest?.dsh?.profile?.bundles
    ?? manifest?.dsh?.profile?.bundle
    ?? manifest?.dsh?.bundles
  const bundles = Array.isArray(bundlesRaw) ? bundlesRaw.filter((b) => typeof b === 'string') : []

  const filename = runtime?.compatibilityFilename ?? 'compatibility.json'
  const file = path.join(profileDir, filename)

  let parsed
  let source = 'self'
  // 优先用 dsh 自己的读取器：schema 校验与警告文案都以它为准（0.1.7+ 才有）
  const reader = runtime?.readers?.compatibility
  if (typeof reader === 'function') {
    try {
      const result = reader(profileDir)
      if (result && typeof result === 'object'
          && result.exemptions !== null && typeof result.exemptions === 'object'
          && !Array.isArray(result.exemptions)) {
        parsed = {
          present: fs.existsSync(file),
          exemptions: result.exemptions,
          warnings: Array.isArray(result.warnings) ? result.warnings : [],
          rewritable: result.rewritable !== false,
        }
        source = 'dsh'
      }
    } catch {
      // 读取器行为变了就退回自包含解析，不让它拖垮体检
    }
  }
  if (parsed === undefined) parsed = parseCompatibilityFile(file)

  return {
    manifest,
    manifestError: manifestRead.ok ? undefined : manifestRead.error,
    dependencies,
    bundles,
    bundlesKey: Array.isArray(manifest?.dsh?.profile?.bundles) ? 'dsh.profile.bundles' : '（容错位置）',
    exemptions: parsed.exemptions,
    compatibilityFile: file,
    compatibilityPresent: parsed.present,
    compatibilityWarnings: parsed.warnings,
    compatibilitySource: source,
  }
}

/** 定位一个依赖的实际安装清单。 */
function readInstalled(profileDir, name) {
  const parts = name.split('/')
  const dir = path.join(profileDir, 'node_modules', ...parts)
  const file = path.join(dir, 'package.json')
  const read = readJsonSafe(file)
  if (!read.ok) return { manifest: undefined, dir, file, error: read.error }
  let real = dir
  try { real = fs.realpathSync(dir) } catch { /* 保留原路径 */ }
  return { manifest: read.value, dir: real, file, error: undefined }
}

/**
 * 判定一个 bundle 名是否由 dsh 安装本身提供（而不是 profile 依赖）。
 *
 * scope 从**探测到的 dsh 包名**推出来（`@deepseek-ai/dsh` → `@deepseek-ai`），
 * 不写死 `@deepseek-ai/` —— 万一 dsh 换 scope 或改名，这里跟着变，不用改代码。
 * 同时把 dsh 自报的 DEFAULT_PROFILE_BUNDLES / OPTIONAL_BUNDLES 当作「肯定是自带」的证据。
 */
function readInstallationOwned(installAnchor, name, runtime) {
  const known = runtime?.defaultBundles?.includes(name) || runtime?.optionalBundles?.includes(name)
  // 拿不到运行时描述（定位不到 dsh 安装目录）时，**不能**因此把 `@deepseek-ai/*`
  // 当成第三方包 —— 那会把它误报成「bundles 里引用了但没装」（阻断），
  // 还会在页面上给出「隔离 @deepseek-ai/dsh-base」这种会把 GUI 搞坏的按钮。
  // dsh 自己的 scope 是已知事实，兜底按它判「属于 dsh 自带、本次无法验证」。
  const scope = (typeof runtime?.scope === 'string' && runtime.scope !== '')
    ? runtime.scope
    : '@deepseek-ai'
  const scoped = name.startsWith(`${scope}/`)
  if (!scoped) {
    return { reason: known ? 'probed' : 'not-scoped', present: known === true }
  }
  if (!installAnchor) return { reason: 'no-anchor', present: false }
  const dir = packageDirOf(nodeModulesRootOf(installAnchor), name)
  if (dir === undefined) return { reason: 'no-anchor', present: false }
  const candidate = path.join(dir, 'package.json')
  const read = readJsonSafe(candidate)
  return {
    reason: 'probed',
    present: read.ok || known === true,
    version: read.ok ? read.value?.version : undefined,
    path: candidate,
  }
}

/**
 * 读取 installAnchor 对应的 dsh 运行时版本。
 * @param {string} installAnchor dsh 的 package.json 绝对路径
 * @returns {string|undefined}
 */
export function readRuntimeVersion(installAnchor) {
  if (!installAnchor) return undefined
  const read = readJsonSafe(installAnchor)
  return read.ok && typeof read.value?.version === 'string' ? read.value.version : undefined
}

/**
 * 不探测时的**同步**运行时描述。
 *
 * 只从安装清单读出「叫什么、什么版本、scope 是什么」，**不声称任何预检能力**
 * （`builtIn.determined = false`）—— 于是所有「dsh 会不会发现」的标签都是
 * `unknown`，而不是替 dsh 打包票。想看实测结论请用 `auditProfileProbed()`。
 */
export function syncRuntime(installAnchor) {
  const read = installAnchor ? readJsonSafe(installAnchor) : { ok: false }
  const packageName = read.ok && typeof read.value?.name === 'string' ? read.value.name : undefined
  const slash = typeof packageName === 'string' ? packageName.indexOf('/') : -1
  return {
    anchor: installAnchor,
    found: read.ok,
    version: read.ok && typeof read.value?.version === 'string' ? read.value.version : undefined,
    versionSource: read.ok ? 'anchor-manifest（未做能力探测）' : 'unknown',
    packageName,
    scope: slash === -1 ? undefined : packageName.slice(0, slash),
    nodeModulesRoot: installAnchor ? nodeModulesRootOf(installAnchor) : undefined,
    appBoot: { loaded: false, reason: '未探测（syncRuntime）' },
    profilesDirName: 'profiles',
    patchFilename: 'cordis.patch.yml',
    compatibilityFilename: 'compatibility.json',
    compatibilitySupported: false,
    defaultBundles: [],
    optionalBundles: [],
    readers: {},
    builtIn: { ...DEFAULT_BUILT_IN },
    notes: [],
  }
}

/**
 * 审计一个 profile（同步）。**永不抛异常** —— 体检工具自己不能把宿主搞挂。
 *
 * @param {object} options
 * @param {string} options.profileDir profile 绝对目录
 * @param {string} [options.profileName] profile 名（用于生成修复命令）
 * @param {string} [options.installAnchor] dsh 的 package.json 绝对路径
 * @param {string} [options.runtimeVersion] 不传则从 runtime/anchor 读
 * @param {object} [options.runtime] adapt.js 探测出来的运行时描述（决定标签与后果描述）
 * @param {string} [options.nodeVersion] 默认 process.versions.node
 * @returns {object} 报告
 */
export function auditProfile(options) {
  const {
    profileDir,
    profileName = path.basename(profileDir),
    installAnchor,
    nodeVersion = process.versions?.node,
  } = options
  const runtime = options.runtime ?? syncRuntime(installAnchor)
  const checkedAt = new Date().toISOString()

  try {
    const runtimeVersion = options.runtimeVersion ?? runtime.version ?? readRuntimeVersion(installAnchor)
    const profile = readProfile(profileDir, runtime)
    // 连 profile 的 package.json 都读不到 → 这次体检等于没做，必须如实报错，
    // 不能「0 个条目、0 个问题」地假装通过
    if (!profile.manifest) {
      throw new Error(
        `读不到 profile 的 package.json（${path.join(profileDir, 'package.json')}）：`
        + `${profile.manifestError ?? '未知原因'}`,
      )
    }
    const items = []

    for (const [name, declaredSpec] of Object.entries(profile.dependencies)) {
      const installed = readInstalled(profileDir, name)
      const installedVersion = installed.manifest?.version
        ?? (typeof declaredSpec === 'string' ? declaredSpec : undefined)
      const inBundles = profile.bundles.includes(name)

      const evaluated = evaluateManifest({
        name,
        manifest: installed.manifest,
        manifestError: installed.error,
        installedVersion,
        runtimeVersion: runtimeVersion ?? '',
        nodeVersion,
        exemptions: profile.exemptions,
        inBundles,
        declaredSpec,
        builtIn: runtime.builtIn,
      })

      // 「快要不适配」的前瞻判断：现在能用，但下一个 dsh 版本就会失配。
      // 刻意定成 info 级 —— 它**不是当前故障**，不该让 CLI 直接退出 1，
      // 否则健康的 profile 也会报警，预警就成了狼来了。
      const upgradeRisk = assessUpgradeRisk(
        {
          peers: Object.entries(collectDshPeers(installed.manifest)).map(([peerName, range]) => ({ name: peerName, range })),
          declared: collectDshRanges(installed.manifest),
        },
        runtimeVersion ?? '',
      )
      if (needsUpgradeWarning(upgradeRisk) && inBundles) {
        evaluated.findings.push(finding(
          FINDING.UPGRADE_RISK,
          SEVERITY.INFO,
          `升级风险：${upgradeRisk.levelText}`,
          `${upgradeRisk.worst.where} 声明为 \`${upgradeRisk.worst.range}\`，${upgradeRisk.worst.reason}。`
            + `当前 dsh ${runtimeVersion ?? '（未知）'} 仍在它接受的范围内，所以现在还能加载；`
            + '但升级 dsh 之前应当先处理这个插件（升级它 / 隔离它 / 卸载它），否则升级后它会被拒绝加载。',
          {
            label: BUILT_IN.UNKNOWN,
            source: '这是本插件对「未来版本」的推算，不是 dsh 的判定 —— dsh 只判当前版本',
          },
          {
            level: upgradeRisk.level,
            breaksAt: upgradeRisk.worst.breaksAt,
            where: upgradeRisk.worst.where,
            range: upgradeRisk.worst.range,
          },
        ))
        if (evaluated.severity === SEVERITY.OK) evaluated.severity = SEVERITY.INFO
      }

      items.push({
        name,
        manifestName: installed.manifest?.name ?? name,
        installedVersion,
        declaredSpec,
        resolver: resolverOf(declaredSpec),
        installDir: installed.dir,
        inBundles,
        upgradeRisk,
        // dsh 只会加载 bundles 里的包；不在 bundles 里的即使装了对运行时也没影响
        affectsRuntime: inBundles,
        severity: evaluated.severity,
        unverifiable: evaluated.unverifiable,
        findings: evaluated.findings,
      })
    }

    // bundles 里引用了、但既不在依赖里也不是 dsh 安装自带的包 —— dsh 会打印 skipping 并跳过
    // 注意标签用 `unknown` 而不是 `covered`：dsh 的**加载器**确实会打印
    // `skipping profile bundle`，但那属于加载日志、不是兼容性预检，而且本次没能实测确认
    // （要实测得调 dsh 的 prepareProfileEntries，代价太大）。不确定就说不确定。
    const bundleLoaderLabel = {
      label: BUILT_IN.UNKNOWN,
      source: '未实测确认（dsh 加载器通常会打印 skipping profile bundle，但它不是兼容性预检）',
    }
    const bundleIssues = []
    for (const bundle of profile.bundles) {
      if (Object.hasOwn(profile.dependencies, bundle)) continue
      const owned = readInstallationOwned(installAnchor, bundle, runtime)
      if (owned.reason === 'probed' && owned.present) continue

      let severity
      let title
      let detail
      if (owned.reason === 'no-anchor') {
        // 名字属于 dsh 自带的 scope，但这次没定位到安装目录 —— 无法验证，
        // 不能误报成「缺包」
        severity = SEVERITY.INFO
        title = '无法验证这个 dsh 自带 bundle'
        detail = '它不在 profile 的 dependencies 里，名字属于 dsh 安装自带的 scope；'
          + '但本次没有定位到 dsh 安装目录，所以无法确认它是否真的存在。'
          + 'dsh 自己会从安装目录解析它。传 --anchor <dsh 的 package.json> 可让本次检查覆盖它。'
      } else if (owned.reason === 'probed') {
        severity = SEVERITY.BLOCK
        title = 'bundles 里引用了但 dsh 安装目录里没有'
        detail = `它不在 profile 依赖里，也没在 dsh 安装目录里找到（找过 ${owned.path}）。`
          + 'dsh 启动时会打印 `skipping profile bundle` 并跳过它。'
      } else {
        severity = SEVERITY.BLOCK
        title = 'bundles 里引用了但没装'
        detail = '它既不在 profile 的 dependencies 里，也不是 dsh 安装自带的包。'
          + 'dsh 启动时会打印 `skipping profile bundle` 并跳过它。'
      }

      if (severity === SEVERITY.BLOCK) {
        bundleIssues.push({ bundle, reason: owned.reason, probedPath: owned.path })
      }
      items.push({
        name: bundle,
        manifestName: bundle,
        installedVersion: undefined,
        declaredSpec: undefined,
        resolver: 'unknown',
        installDir: undefined,
        inBundles: true,
        affectsRuntime: true,
        severity,
        unverifiable: false,
        findings: [finding(
          FINDING.BUNDLE_UNRESOLVED,
          severity,
          title,
          detail,
          bundleLoaderLabel,
          { bundle, reason: owned.reason, probedPath: owned.path },
        )],
      })
    }

    items.sort((a, b) => {
      const d = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })

    /**
     * 「快要不适配」清单：**现在还能用**、但下一个 dsh 版本就会失配的插件。
     * 只列真正会被 dsh 加载的（inBundles）—— 没被加载的插件失配也无所谓。
     */
    const upcoming = items
      .filter((item) => item.affectsRuntime === true && item.upgradeRisk !== undefined && needsUpgradeWarning(item.upgradeRisk))
      .map((item) => ({
        name: item.name,
        version: item.installedVersion,
        level: item.upgradeRisk.level,
        levelText: item.upgradeRisk.levelText,
        breaksAt: item.upgradeRisk.worst?.breaksAt,
        where: item.upgradeRisk.worst?.where,
        range: item.upgradeRisk.worst?.range,
        reason: item.upgradeRisk.worst?.reason,
      }))

    const summary = {
      total: items.length,
      blocked: items.filter((i) => i.severity === SEVERITY.BLOCK).length,
      warned: items.filter((i) => i.severity === SEVERITY.WARN).length,
      ok: items.filter((i) => i.severity === SEVERITY.OK).length,
      info: items.filter((i) => i.severity === SEVERITY.INFO).length,
      unverifiable: items.filter((i) => i.unverifiable).length,
      bundleIssues: bundleIssues.length,
      upcoming: upcoming.length,
    }
    summary.problems = summary.blocked + summary.warned

    return {
      schema: 'dsh-compat-doctor/v1',
      checkedAt,
      runtimeVersion: runtimeVersion ?? null,
      nodeVersion: nodeVersion ?? null,
      profile: {
        name: profileName,
        dir: profileDir,
        installAnchor: installAnchor ?? null,
        bundles: profile.bundles,
        dependencyCount: Object.keys(profile.dependencies).length,
        compatibilityPresent: profile.compatibilityPresent,
        compatibilityFile: profile.compatibilityFile,
        compatibilitySource: profile.compatibilitySource,
        compatibilityWarnings: profile.compatibilityWarnings,
        bundlesKey: profile.bundlesKey,
      },
      exemptions: profile.exemptions,
      adaptation: adaptationOf(runtime),
      summary,
      bundleIssues,
      upcoming,
      items,
      error: undefined,
    }
  } catch (error) {
    // 体检工具自身出问题时，如实报告而不是让调用方炸掉
    return {
      schema: 'dsh-compat-doctor/v1',
      checkedAt,
      runtimeVersion: options.runtimeVersion ?? null,
      nodeVersion: nodeVersion ?? null,
      profile: { name: profileName, dir: profileDir, installAnchor: installAnchor ?? null },
      exemptions: {},
      adaptation: adaptationOf(runtime),
      summary: { total: 0, blocked: 0, warned: 0, ok: 0, info: 0, unverifiable: 0, bundleIssues: 0, problems: 0 },
      bundleIssues: [],
      upcoming: [],
      items: [],
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

/** 把 runtime 描述压成报告里要展示的「适配信息」。 */
function adaptationOf(runtime) {
  const b = runtime?.builtIn ?? DEFAULT_BUILT_IN
  const verdictText = {
    effective: '存在且实测有效',
    inert: '存在但实测不报任何问题',
    'over-eager': '存在但实测连兼容的 peer 也报（可能偏严）',
    absent: '实测该版本没有这个检查',
    unknown: '未能实测',
  }[b.verdict] ?? '未能实测'
  return {
    version: runtime?.version ?? null,
    versionSource: runtime?.versionSource ?? 'unknown',
    scope: runtime?.scope ?? null,
    nodeModulesRoot: runtime?.nodeModulesRoot ?? null,
    appBootProbed: runtime?.appBoot?.loaded === true,
    appBootReason: runtime?.appBoot?.reason,
    profilesDirName: runtime?.profilesDirName ?? 'profiles',
    patchFilename: runtime?.patchFilename ?? 'cordis.patch.yml',
    compatibilityFilename: runtime?.compatibilityFilename ?? 'compatibility.json',
    compatibilitySupported: runtime?.compatibilitySupported === true,
    builtIn: {
      verdict: b.verdict,
      verdictText,
      determined: b.determined === true,
      calibrated: b.calibrated === true,
      seesPeerMismatch: b.seesPeerMismatch === true,
      seesPeerlessPlugin: b.seesPeerlessPlugin === true,
      seesDeclaredRange: b.seesDeclaredRange === true,
      deniesAtStartup: b.deniesAtStartup,
      exemptionMechanism: b.exemptionMechanism === true,
    },
    notes: Array.isArray(runtime?.notes) ? runtime.notes : [],
  }
}

/**
 * 先探测本机 dsh 的能力（含实测校准），再审计 —— **推荐的入口**。
 *
 * 与同步版 auditProfile() 的区别：探测要动态 import，所以是异步的；
 * 换来的是「dsh 自己会不会发现这些问题」与「不兼容会不会被拦下」都来自**实测**。
 */
export async function auditProfileProbed(options) {
  const runtime = options.runtime ?? await probeRuntime({
    installAnchor: options.installAnchor,
    profileDir: options.profileDir,
    profileName: options.profileName,
  })
  return auditProfile({
    ...options,
    installAnchor: options.installAnchor ?? runtime.anchor,
    runtime,
  })
}
