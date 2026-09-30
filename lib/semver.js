/**
 * 自包含的 SemVer 范围求值器。
 *
 * 为什么不直接用 `semver` 包：
 *   dsh 把插件装在 profile 的 node_modules 下，而 `link:` 安装的插件**真实路径在 profile 之外**，
 *   Node 的 ESM 解析会从真实路径向上找 node_modules —— 找不到 dsh 自带的 `semver`，
 *   也找不到 `@deepseek-ai/dsh-app-boot`。所以这个插件刻意**零 DSH 依赖**：
 *   连「dsh 已经坏到起不来」时，独立 CLI 仍然要能跑。
 *
 * 语义严格对齐 `semver.satisfies(v, range, { includePrerelease: true })`
 * —— dsh 自己就是这么调的（见 @deepseek-ai/dsh-app-boot `evaluatePluginCompatibility`）。
 *
 * 正确性由 test/semver.test.mjs 的「与本机真 semver 穷举对拍」用例保证 ——
 * 下面的 desugar 规则全部是实测出来的，不是猜的：
 *
 *   部分版本（段数 < 3）或含 x/X/* 的段，边界一律补 `-0`：
 *     >=1.2      → >=1.2.0-0
 *     >1.2       → >=1.3.0-0          （注意是「下一段进位」，不是 1.2.1）
 *     <=1.2      → <1.3.0-0
 *     <1.2       → <1.2.0-0
 *     1 / =1     → >=1.0.0-0 <2.0.0-0
 *     1.2.x      → >=1.2.0-0 <1.3.0-0
 *   完整三段版本保持原样（预发布也保留）：
 *     >=1.2.3 → >=1.2.3 ； >1.2.3 → >1.2.3 ； 1.2.3 → =1.2.3
 *   caret / tilde 的上界一律带 `-0`；下界三段带预发布、不足三段补 `-0`：
 *     ^1.2   → >=1.2.0-0 <2.0.0-0 ； ^0.1.5-0 → >=0.1.5-0 <0.2.0-0
 *     ~1.2   → >=1.2.0-0 <1.3.0-0
 *   连字符区间：下界**总是**补 `-0`，上界**进位到下一段**：
 *     1.2.3 - 2.3.4 → >=1.2.3-0 <2.3.5-0
 */

/** 版本号正则：major[.minor[.patch]][-prerelease][+build] */
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/**
 * 解析**严格**版本号（范围里的通配段不接受）。
 * @param {string} raw 版本字符串（允许前缀 v）
 * @returns {{major:number,minor:number,patch:number,pre:string[],build:string[],raw:string,parts:number}|null}
 */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  const m = VERSION_RE.exec(text)
  if (!m) return null
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).length
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
    build: m[5] === undefined ? [] : m[5].split('.'),
    raw: text,
    parts,
  }
}

/**
 * 解析范围里的版本片段，允许部分段与通配段。
 * @returns {{major:number,minor:number,patch:number,pre:string[],n:number}|null}
 *          `n` = 连续具体段的个数，0 表示 `*`（任意）；null 表示非法
 */
function parsePartial(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text.startsWith('v') || text.startsWith('V')) text = text.slice(1)
  if (text === '') return null

  // 先剥离 build 元数据与预发布
  let build = ''
  const plus = text.indexOf('+')
  if (plus >= 0) { build = text.slice(plus + 1); text = text.slice(0, plus) }
  let pre = ''
  const dash = text.indexOf('-')
  if (dash >= 0) { pre = text.slice(dash + 1); text = text.slice(0, dash) }

  const segs = text.split('.')
  if (segs.length > 3) return null
  const nums = []
  let n = null
  for (const seg of segs) {
    if (/^\d+$/.test(seg)) {
      if (n !== null) return null // 通配段之后又出现数字 → 非法（如 1.x.2）
      nums.push(Number(seg))
    } else if (/^[xX*]$/.test(seg)) {
      if (n === null) n = nums.length
    } else {
      return null
    }
  }
  if (n === null) n = nums.length

  const major = nums[0] ?? 0
  const minor = nums[1] ?? 0
  const patch = nums[2] ?? 0
  // 预发布只在完整三段时才有意义
  const preIds = n === 3 && pre !== '' ? pre.split('.') : []
  void build
  return { major, minor, patch, pre: preIds, n }
}

/** "1.2" + n=2 → "1.2.0"；不足的段补 0。 */
function zeroPad(p) {
  return p.n === 1 ? `${p.major}.0.0` : p.n === 2 ? `${p.major}.${p.minor}.0` : `${p.major}.${p.minor}.${p.patch}`
}

/** 在 n 段版本上「进位到下一段」：n=1 → major+1；n=2 → minor+1；n=3 → patch+1。 */
function bumpVersion(p) {
  if (p.n === 1) return `${p.major + 1}.0.0`
  if (p.n === 2) return `${p.major}.${p.minor + 1}.0`
  return `${p.major}.${p.minor}.${p.patch + 1}`
}

const ANY = { any: true }

/**
 * 把单个比较器 token 展开成区间。
 * @param {string} token
 * @param {boolean} includePrerelease 影响**部分版本下界**是否补 `-0`（实测 npm 行为）
 * @returns {{lo:object|null, hi:object|null, any?:boolean}|null} null 表示非法
 */
function expandComparator(token, includePrerelease) {
  const t = token.trim()
  if (t === '' || t === '*' || t === 'x' || t === 'X') return ANY

  // 部分版本的下界补 `-0`，这样才能容纳边界上的预发布版；
  // 但 includePrerelease=false 时 npm 不补（否则预发布版会被误放行）。
  const z = includePrerelease ? '-0' : ''

  // caret
  if (t.startsWith('^')) {
    const p = parsePartial(t.slice(1))
    if (!p) return null
    if (p.n === 0) return ANY
    const box = zeroPad(p)
    // npm 对 ^0 / ^0.0 只给出上界（下界 0.0.0 直接省略）——
    // 补上 `>=0.0.0-0` 会让它变成一个「带预发布的边界」，
    // 从而在 includePrerelease=false 时错误放行 0.0.0-0，必须照 npm 省略。
    const omitLo = p.n < 3 && p.major === 0 && p.minor === 0 && p.patch === 0
    const lo = p.n === 3 ? (p.pre.length ? `${box}-${p.pre.join('.')}` : box) : `${box}${z}`
    let hi
    if (p.major > 0) hi = `${p.major + 1}.0.0-0`
    else if (p.n === 1) hi = '1.0.0-0'
    else if (p.minor > 0) hi = `0.${p.minor + 1}.0-0`
    else if (p.n === 2) hi = '0.1.0-0'
    else hi = `0.0.${p.patch + 1}-0`
    return { lo: omitLo ? null : { v: lo, inc: true }, hi: { v: hi, inc: false } }
  }

  // tilde
  if (t.startsWith('~')) {
    const p = parsePartial(t.slice(1))
    if (!p) return null
    if (p.n === 0) return ANY
    const box = zeroPad(p)
    const lo = p.n === 3 ? (p.pre.length ? `${box}-${p.pre.join('.')}` : box) : `${box}${z}`
    const hi = p.n === 1 ? `${p.major + 1}.0.0-0` : `${p.major}.${p.minor + 1}.0-0`
    return { lo: { v: lo, inc: true }, hi: { v: hi, inc: false } }
  }

  // 显式运算符
  const opMatch = /^(>=|<=|>|<|=)\s*(.+)$/.exec(t)
  if (opMatch) {
    const op = opMatch[1]
    const p = parsePartial(opMatch[2])
    if (!p) return null
    if (p.n === 0) return ANY
    const box = zeroPad(p)
    const bump = bumpVersion(p)

    if (p.n < 3) {
      // 上界（< / <=）恒带 `-0`；下界（>= / >）按模式决定是否带 `-0`
      switch (op) {
        case '>=': return { lo: { v: `${box}${z}`, inc: true }, hi: null }
        case '>': return { lo: { v: `${bump}${z}`, inc: true }, hi: null }
        case '<': return { lo: null, hi: { v: `${box}-0`, inc: false } }
        case '<=': return { lo: null, hi: { v: `${bump}-0`, inc: false } }
        default: return { lo: { v: `${box}${z}`, inc: true }, hi: { v: `${bump}-0`, inc: false } }
      }
    }

    const full = p.pre.length ? `${box}-${p.pre.join('.')}` : box
    switch (op) {
      case '>=': return { lo: { v: full, inc: true }, hi: null }
      case '>': return { lo: { v: full, inc: false }, hi: null }
      case '<': return { lo: null, hi: { v: full, inc: false } }
      case '<=': return { lo: null, hi: { v: full, inc: true } }
      default: return { lo: { v: full, inc: true }, hi: { v: full, inc: true } }
    }
  }

  // 裸版本片段：X / X.Y / X.Y.Z / X.x
  const p = parsePartial(t)
  if (!p) return null
  if (p.n === 0) return ANY
  const box = zeroPad(p)
  if (p.n < 3) {
    return { lo: { v: `${box}${z}`, inc: true }, hi: { v: `${bumpVersion(p)}-0`, inc: false } }
  }
  const full = p.pre.length ? `${box}-${p.pre.join('.')}` : box
  return { lo: { v: full, inc: true }, hi: { v: full, inc: true } }
}

/**
 * 展开连字符区间 `A - B`。
 * 下界按模式决定是否补 `-0`；上界：完整版本时 `includePrerelease` 决定用
 * `<下一段-0` 还是 `<=原值`，部分版本时恒为 `<进位-0`。
 */
function expandHyphen(from, to, includePrerelease) {
  const a = parsePartial(from)
  const b = parsePartial(to)
  if (!a || !b || a.n === 0 || b.n === 0) return null
  const z = includePrerelease ? '-0' : ''
  const lo = `${zeroPad(a)}${z}`
  const hiCmp = b.n === 3
    ? (includePrerelease
        ? { v: `${bumpVersion(b)}-0`, inc: false }
        : { v: zeroPad(b), inc: true })
    : { v: `${bumpVersion(b)}-0`, inc: false }
  return [
    { lo: { v: lo, inc: true }, hi: null },
    { lo: null, hi: hiCmp },
  ]
}

/** 单个标识符比较：纯数字 < 字母数字。 */
function compareIdentifier(a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** 预发布段比较（SemVer §11）。空数组代表正式版，正式版 > 任何预发布版。 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const c = compareIdentifier(a[i], b[i])
    if (c !== 0) return c
  }
  return Math.sign(a.length - b.length)
}

/**
 * 比较两个版本。
 * @param {string|object} a 版本串或 parseVersion 结果
 * @param {string|object} b 同 a
 * @returns {number} -1 / 0 / 1
 * @throws {Error} 任一侧无法解析（宁可炸也不要静默给出错误结论）
 */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a
  const y = typeof b === 'string' ? parseVersion(b) : b
  if (!x) throw new Error(`无法解析版本号: ${String(a)}`)
  if (!y) throw new Error(`无法解析版本号: ${String(b)}`)
  if (x.major !== y.major) return Math.sign(x.major - y.major)
  if (x.minor !== y.minor) return Math.sign(x.minor - y.minor)
  if (x.patch !== y.patch) return Math.sign(x.patch - y.patch)
  return comparePrerelease(x.pre, y.pre)
}

/** 判断区间是否容纳该版本。 */
function inRange(version, cmp) {
  if (cmp.any) return true
  if (cmp.lo) {
    const c = compareVersions(version.raw, cmp.lo.v)
    if (c < 0 || (c === 0 && !cmp.lo.inc)) return false
  }
  if (cmp.hi) {
    const c = compareVersions(version.raw, cmp.hi.v)
    if (c > 0 || (c === 0 && !cmp.hi.inc)) return false
  }
  return true
}

/** 区间的边界里是否有「与该版本同 major.minor.patch 的预发布边界」。 */
function rangeMentionsPrereleaseOf(cmp, version) {
  for (const bound of [cmp.lo, cmp.hi]) {
    if (!bound) continue
    const bv = parseVersion(bound.v)
    if (!bv || bv.pre.length === 0) continue
    if (bv.major === version.major && bv.minor === version.minor && bv.patch === version.patch) return true
  }
  return false
}

/**
 * 判断版本是否落在范围内 —— 对齐 `semver.satisfies`。
 *
 * @param {string} version 待判定版本（如 dsh 运行时版本 0.2.0-rc.2）
 * @param {string} range 范围表达式（支持 `||`、空格分隔、`^`、`~`、`>=`、`-` 连字符区间、`x`/`*`）
 * @param {{includePrerelease?:boolean}} [options] 默认 includePrerelease=false
 * @returns {boolean} 范围非法时返回 false
 */
export function satisfies(version, range, options = {}) {
  const includePrerelease = options.includePrerelease === true
  const v = parseVersion(version)
  if (!v) return false
  if (typeof range !== 'string') return false

  const text = range.trim()
  // dsh 自己会先把 workspace:^ 这几种替换成运行时版本；这里遇到就当作恒真，
  // 并把判断权交回调用方（见 audit.js 的 workspace 处理）。
  if (/^workspace:/.test(text)) return true
  if (text === '') return true

  for (const union of text.split('||')) {
    const part = union.trim()
    if (part === '') continue

    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(part)
    let comparators
    if (hyphen) {
      comparators = expandHyphen(hyphen[1], hyphen[2], includePrerelease)
      if (!comparators) continue
    } else {
      const tokens = part.split(/\s+/).filter(Boolean)
      comparators = []
      let bad = false
      for (const token of tokens) {
        const cmp = expandComparator(token, includePrerelease)
        if (!cmp) { bad = true; break }
        comparators.push(cmp)
      }
      if (bad) continue
    }

    if (!comparators.every((cmp) => inRange(v, cmp))) continue

    // npm 的预发布规则：不开 includePrerelease 时，带预发布的版本只有在
    // 同一 union 里存在「同 major.minor.patch 且带预发布」的边界才被放行。
    if (!includePrerelease && v.pre.length > 0) {
      if (!comparators.some((cmp) => rangeMentionsPrereleaseOf(cmp, v))) continue
    }
    return true
  }
  return false
}

/**
 * 范围表达式是否合法（`semver.validRange` 的等价物）。
 * @param {string} range 范围表达式
 * @returns {boolean}
 */
export function validRange(range) {
  if (typeof range !== 'string') return false
  const text = range.trim()
  if (text === '' || /^workspace:/.test(text)) return true
  for (const union of text.split('||')) {
    const part = union.trim()
    if (part === '') continue
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(part)
    if (hyphen) {
      if (!expandHyphen(hyphen[1], hyphen[2], true)) return false
      continue
    }
    for (const token of part.split(/\s+/).filter(Boolean)) {
      if (!expandComparator(token, true)) return false
    }
  }
  return true
}
