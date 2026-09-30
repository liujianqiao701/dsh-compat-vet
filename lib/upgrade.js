/**
 * 「快要不适配」的前瞻分析 —— 在插件还没坏的时候就把话说在前面。
 *
 * 为什么单独一个模块：这是本插件唯一**预测未来**的部分，逻辑必须能被单独测透，
 * 而且它的结论会被页面横幅直接显示给用户，说错了比不说更糟。
 *
 * 判断依据（全部离线可算，不联网、不猜）：
 *   插件声明的 dsh 版本范围 R + 当前 dsh 版本 C。
 *   · R 不满足 C            → 已经坏了（由 audit.js 的 declared-range 负责报，这里不重复）
 *   · R 满足 C，但满足不到「下一个版本」→ **快到点了**：dsh 一升就会不兼容
 *   · R 是精确钉死 / 只收补丁号    → 任何时候升 dsh 都危险
 *   · R 是开放上限（如 >=0.1.2-rc.1）→ 安全，升 dsh 不用管它
 *
 * 「下一个版本」取两档：下一个小版本（0.2.0-rc.2 → 0.3.0）与下一个大版本（→ 1.0.0）。
 * 这样能区分「小升级就炸」和「只有大版本升级才会炸」—— 严重程度完全不同。
 */
import { satisfies, validRange, parseVersion } from './semver.js'

export const RISK_LEVEL = {
  /** 声明范围开放，升 dsh 不用管它。 */
  SAFE: 'safe',
  /** 只有跨大版本才需要处理。 */
  WATCH: 'watch',
  /** 下一个小版本升级就会不兼容。 */
  FRAGILE: 'fragile',
  /** 现在已经不满足了（这里不报，由 audit 的 declared-range 负责）。 */
  BROKEN: 'broken',
  /** 范围本身解析不了，无法预测。 */
  UNKNOWN: 'unknown',
}

const LEVEL_TEXT = {
  safe: '范围开放，升级 dsh 不受影响',
  watch: '跨大版本升级时需要处理',
  fragile: '下一个小版本升级就会不兼容',
  broken: '当前版本已不满足',
  unknown: '范围无法解析，预测不了',
}

/** 小版本 +1、补丁与预发布清零：0.2.0-rc.2 → 0.3.0。 */
export function nextMinor(version) {
  const parsed = parseVersion(version)
  if (parsed === undefined || parsed === null) return undefined
  return `${parsed.major}.${parsed.minor + 1}.0`
}

/** 大版本 +1、其余清零：0.2.0-rc.2 → 1.0.0。 */
export function nextMajor(version) {
  const parsed = parseVersion(version)
  if (parsed === undefined || parsed === null) return undefined
  return `${parsed.major + 1}.0.0`
}

/**
 * 范围是否「钉死」到某个具体版本 —— 这种写法最脆，任何 dsh 升级都可能失配。
 * 判定：整个范围里没有任何比较符/通配符，就是裸版本号（含 `=x.y.z`）。
 */
export function isPinnedRange(range) {
  const text = String(range).trim()
  if (text === '' || text === '*' || text === 'x' || text === 'X') return false
  // 去掉 `=`、`v` 前缀与空白后，若剩下的全是版本号/分隔符，就是钉死
  return text.split(/\s*\|\|\s*/).every((part) => {
    const piece = part.trim().replace(/^=/, '').replace(/^v/, '')
    return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(piece)
  })
}

/** 范围是否只收补丁号（`~x.y.z`）—— 同样很脆，但比钉死略好。 */
export function isPatchOnlyRange(range) {
  return String(range).split(/\s*\|\|\s*/).every((part) => part.trim().startsWith('~'))
}

/**
 * 评估一个声明范围的升级风险。
 *
 * @param {string} range 插件声明的 dsh 版本范围
 * @param {string} currentVersion 当前 dsh 版本
 * @returns {{level:string, levelText:string, breaksAt:string|undefined, reason:string, range:string}}
 */
export function assessRange(range, currentVersion) {
  const base = { range: String(range), breaksAt: undefined }
  if (typeof range !== 'string' || range.trim() === '' || typeof currentVersion !== 'string' || currentVersion === '') {
    return { ...base, level: RISK_LEVEL.UNKNOWN, levelText: LEVEL_TEXT.unknown, reason: '缺少范围或运行时版本' }
  }
  // 注意：本模块自带的 validRange 返回**布尔**（能不能解析），不是规范化后的范围字符串
  if (!validRange(range)) {
    return { ...base, level: RISK_LEVEL.UNKNOWN, levelText: LEVEL_TEXT.unknown, reason: '范围不是合法 SemVer 范围' }
  }
  if (!satisfies(currentVersion, range, { includePrerelease: true })) {
    return { ...base, level: RISK_LEVEL.BROKEN, levelText: LEVEL_TEXT.broken, reason: '当前 dsh 已经不满足这个范围' }
  }

  const minor = nextMinor(currentVersion)
  const major = nextMajor(currentVersion)
  const minorOk = minor === undefined ? true : satisfies(minor, range, { includePrerelease: true })
  const majorOk = major === undefined ? true : satisfies(major, range, { includePrerelease: true })

  // 钉死 / 只收补丁号这两种写法先判：它们**任何**版本变化都可能失配，
  // 说成「升到下一个小版本就坏」反而不够准，会让人以为只要不跨小版本就没事。
  if (isPinnedRange(range)) {
    return {
      ...base,
      level: RISK_LEVEL.FRAGILE,
      breaksAt: minor,
      levelText: LEVEL_TEXT.fragile,
      reason: '范围把版本钉死了，dsh 只要一动就可能失配',
    }
  }
  if (isPatchOnlyRange(range)) {
    return {
      ...base,
      level: RISK_LEVEL.FRAGILE,
      breaksAt: minor,
      levelText: LEVEL_TEXT.fragile,
      reason: '范围只接受补丁号变化（~），dsh 升小版本即失配',
    }
  }
  if (!minorOk) {
    return {
      ...base,
      level: RISK_LEVEL.FRAGILE,
      breaksAt: minor,
      levelText: LEVEL_TEXT.fragile,
      reason: `dsh 升到 ${minor} 时该范围就不再满足`,
    }
  }
  if (!majorOk) {
    return {
      ...base,
      level: RISK_LEVEL.WATCH,
      breaksAt: major,
      levelText: LEVEL_TEXT.watch,
      reason: `dsh 升到 ${major} 时该范围就不再满足`,
    }
  }
  return { ...base, level: RISK_LEVEL.SAFE, levelText: LEVEL_TEXT.safe, reason: '范围上限开放，升级 dsh 不会因版本失配' }
}

/**
 * 把一个插件所有 dsh 相关声明（peer + 三种野生写法）汇总成一条升级风险结论。
 *
 * 取**最严重**的那条：只要有任何一个声明会先坏，就按它预警 ——
 * 兼容性上「最弱的那个约束」才是真正的约束。
 *
 * @param {{peers?: Array<{name:string, range:string}>, declared?: Array<{source:string, range:string}>}} input
 * @param {string} currentVersion
 */
export function assessUpgradeRisk({ peers = [], declared = [] } = {}, currentVersion) {
  const rank = { broken: 4, fragile: 3, watch: 2, unknown: 1, safe: 0 }
  const items = []
  for (const { name, range } of peers) {
    items.push({ where: `peerDependencies["${name}"]`, ...assessRange(range, currentVersion) })
  }
  for (const { source, range } of declared) {
    items.push({ where: source, ...assessRange(range, currentVersion) })
  }
  if (items.length === 0) return { level: RISK_LEVEL.UNKNOWN, levelText: LEVEL_TEXT.unknown, items: [], worst: undefined }

  let worst = items[0]
  for (const item of items) if ((rank[item.level] ?? 0) > (rank[worst.level] ?? 0)) worst = item
  return { level: worst.level, levelText: worst.levelText, items, worst }
}

/** 是否值得为它提前预警（safe / broken 都不进这一栏：后者已经报过了）。 */
export function needsUpgradeWarning(assessment) {
  return assessment.level === RISK_LEVEL.FRAGILE || assessment.level === RISK_LEVEL.WATCH
}
