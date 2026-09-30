/**
 * 定位 dsh 安装目录（installAnchor = dsh 的 package.json 绝对路径）。
 *
 * 为什么要单独一个模块：CLI 与单元测试都要用它 ——
 * 测试要靠它找到 dsh 自带的真 `semver`，用来对拍本插件自己实现的求值器。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** 在 PATH 上找 dsh 可执行文件，用它的位置反推 dsh 安装目录。 */
export function anchorFromPath() {
  const exts = process.platform === 'win32' ? ['', '.cmd', '.ps1', '.exe'] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const shim = path.join(dir, `dsh${ext}`)
      if (!fs.existsSync(shim)) continue
      // <root>/node_modules/.bin/dsh -> <root>/node_modules/@deepseek-ai/dsh/package.json
      const candidates = [
        path.join(dir, '..', '@deepseek-ai', 'dsh', 'package.json'),
        path.join(dir, '..', 'dsh', 'package.json'),
      ]
      for (const c of candidates) if (fs.existsSync(c)) return c
    }
  }
  return undefined
}

/**
 * 从**当前进程的入口脚本**反推正在运行的 dsh 安装体。
 *
 * 这是权威性最高的来源：PATH 上完全可能有多个 dsh（本机 npx 缓存里就躺着 4 个），
 * 只扫 PATH 有可能定位到**不是正在运行**的那个 —— 那样「实测校准」就测错了对象，
 * 结论看着像实测、其实测的是别人。而入口脚本就是正在跑的这个进程自己，不会错。
 *
 * 只在入口脚本向上确实是 dsh 安装体时才命中，所以 CLI / 测试 / 普通脚本
 * （argv[1] 是 lib/cli.js、test/*.mjs 之类）都不会误报。
 *
 * @param {string[]} [argv]
 * @returns {string|undefined}
 */
export function anchorFromProcessEntry(argv = process.argv) {
  for (const entry of [argv?.[1], process.env.pm_exec_path]) {
    if (typeof entry !== 'string' || entry === '') continue
    let dir = path.dirname(path.resolve(entry))
    for (;;) {
      // 情况 A：入口在 <root>/node_modules/.bin/ 或 <root>/ 下
      const nested = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      // 情况 B：入口就在 dsh 包里（<...>/node_modules/@deepseek-ai/dsh/lib/bin.js）
      const own = path.basename(path.dirname(dir)) === '@deepseek-ai' && path.basename(dir) === 'dsh'
        ? path.join(dir, 'package.json')
        : undefined
      for (const candidate of [nested, own]) {
        try {
          if (candidate !== undefined && fs.existsSync(candidate)) return candidate
        } catch { /* 忽略无权限等 */ }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

/** npx 缓存里通常躺着 dsh 的安装体。 */
export function anchorsFromNpxCache() {
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  if (process.env.HOME) roots.push(path.join(process.env.HOME, '.npm', '_npx'))
  const out = []
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root) } catch { continue }
    for (const entry of entries) {
      out.push(path.join(root, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  return out
}

/**
 * 依次尝试所有已知位置，返回第一个存在的 dsh package.json。
 *
 * 顺序：显式指定 → **正在运行的进程入口** → 环境变量 → PATH → npx/全局缓存。
 * 「正在运行的那个」排在环境变量与 PATH 之前是有意的：它是事实，其余是提示。
 * @param {string} [explicit] 用户显式指定的路径，优先级最高
 * @returns {string|undefined}
 */
export function locateAnchor(explicit) {
  const candidates = [
    explicit,
    anchorFromProcessEntry(),
    process.env.DSH_INSTALL_ANCHOR,
    process.env.DSH_ANCHOR,
    anchorFromPath(),
    ...anchorsFromNpxCache(),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : undefined,
    process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : undefined,
  ].filter((c) => typeof c === 'string' && c !== '')

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* 忽略无权限等 */ }
  }
  return undefined
}

/**
 * 从 installAnchor 推导 dsh 安装体的 node_modules 根（用于取同级的第三方依赖）。
 * @param {string} anchor dsh 的 package.json 路径
 * @returns {string} 形如 <root>/node_modules
 */
export function nodeModulesOf(anchor) {
  // <root>/node_modules/@deepseek-ai/dsh/package.json -> <root>/node_modules
  return path.resolve(path.dirname(anchor), '..', '..')
}
