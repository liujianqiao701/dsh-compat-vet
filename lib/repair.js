/**
 * 修复层 —— 把「发现冲突」变成「真的修掉」，并且**修完必须自证修好了**。
 *
 * 三条硬规矩（这是本模块全部设计取舍的来源）：
 *
 * ① **优先用 dsh 自己的服务，不自己写文件。**
 *    dsh 有现成的宿主服务 `pluginManager`：
 *      · `setBundleEnabled(name,false)` → 从 `dsh.profile.bundles` 摘掉（= 隔离，依赖与 node_modules 保留）
 *      · `removeBundle(name)`           → 彻底卸载
 *      · `installBundle(spec)`          → 装指定版本 / latest
 *    它内部会加 profile 的 `package.json` 文件锁、用原子写、并协调 HMR；
 *    而 `writeProfileManifest` 是**无锁非原子**的 `writeFileSync`。
 *    自己写文件等于绕过锁 —— 万一 GUI 的插件页同时也在写，就会互相覆盖。
 *    所以只有在完全没有 `pluginManager` 的宿主上，才退回自己原子写（并明确告知这一点）。
 *
 * ② **改前必备份，改后必复检，复检不过必回滚。**
 *    「100% 避免下次启动失败」这句话只能这么兑现：备份 → 改 → 复检（我自己的体检 + dsh 自己的判定）
 *    → 任何一项不通过就还原并如实报告「已回滚」。
 *
 * ③ **效果由 dsh 说了算，不由我说了算。**
 *    `ChangeResult.application` 会明确给出 `applied`（本进程已热生效）还是 `restart-required`；
 *    `listBundles()` 里带 **dsh 自己的兼容性判定**（`error.incompatible`）。
 *    复检时以 dsh 的判定为准 —— 我自己的审计只是第二意见。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

/** 用户可以选的修复动作。刻意**不含**「豁免」：那是接受风险，不是修复。 */
export const REPAIR_ACTION = {
  /** 从 dsh.profile.bundles 摘掉：dsh 不再加载它，冲突 100% 消除；可逆、不需联网。 */
  QUARANTINE: 'quarantine',
  /** 彻底卸载：依赖 + bundles + node_modules 一起清掉。 */
  UNINSTALL: 'uninstall',
  /** 升级到最新版（需要联网）。 */
  UPGRADE: 'upgrade',
}

export const ACTION_TEXT = {
  quarantine: '隔离（从 dsh.profile.bundles 摘除，包文件保留，可随时恢复）',
  uninstall: '彻底卸载（依赖 + bundles + node_modules 一起移除）',
  upgrade: '升级到最新版（需要联网，装完若仍不兼容会再次预警）',
}

/** 哪些动作真正保证消除冲突。升级不保证 —— 新版可能还是不兼容。 */
export const GUARANTEED_ACTIONS = [REPAIR_ACTION.QUARANTINE, REPAIR_ACTION.UNINSTALL]

export function isGuaranteed(action) {
  return GUARANTEED_ACTIONS.includes(action)
}

/** 把任意抛出/返回的错误码统一成一句可读中文。 */
export function explainErrorCode(code) {
  switch (code) {
    case 'management-required':
      return 'dsh 把这个包列为受保护模块，拒绝通过插件接口改动它'
    case 'unknown-plugin':
      return 'dsh 不认识这个插件（可能已经不在 profile 里）'
    case 'not-removable':
      return '这个 bundle 由 dsh 安装自带，不属于 profile，不能卸载（可以试试隔离）'
    case 'not-bundle':
      return '这个包不是 bundle，dsh 不把它当插件加载'
    case 'invalid-spec':
      return '版本写法不合法'
    case 'incompatible-version':
      return '装上去仍然不兼容，dsh 拒绝了这次安装'
    case 'stop-profile':
      return '需要先停掉当前 profile 才能执行这个操作'
    case 'bundle-in-use':
      return '这个 bundle 还在被引用，暂时动不了'
    case 'operation-error':
      return '底层包管理器（pnpm）执行失败，通常是网络或依赖解析问题'
    case 'pnpm-missing':
      return 'PATH 上找不到 pnpm，无法装卸插件'
    case 'stale-approval':
      return '审批信息已过期，请重试'
    default:
      return code === undefined ? undefined : `dsh 返回了未预期的错误码：${code}`
  }
}

/** 把 dsh 的返回值/异常统一成 `{ok, code, text, application, raw}`。 */
function normalizeOutcome(value, error) {
  if (error !== undefined && error !== null) {
    const code = error.code ?? error.cause?.code
    return {
      ok: false,
      code,
      text: explainErrorCode(code) ?? String(error.message ?? error),
      raw: undefined,
    }
  }
  const result = value ?? {}
  const code = result.error?.code
  if (code !== undefined) {
    const incompatible = result.error?.incompatible
    const extra = Array.isArray(incompatible) && incompatible.length > 0
      ? `（${incompatible.map((x) => `${x.name}@${x.version}`).join('、')} 与 dsh ${incompatible[0].runtimeVersion} 不兼容）`
      : ''
    return {
      ok: false,
      code,
      text: `${explainErrorCode(code) ?? code}${extra}`,
      application: result.application,
      raw: result,
    }
  }
  return {
    ok: true,
    code: undefined,
    text: undefined,
    application: result.application,
    changed: result.changed,
    raw: result,
  }
}

/** `application` 字段翻译成人话 —— 直接决定我能不能说「已经生效、不用重启」。 */
export function explainApplication(application) {
  switch (application) {
    case 'applied': return '已在本进程立即生效，不需要重启 dsh'
    case 'restart-required': return '需要重启 dsh 才生效'
    case 'overridden': return '被更高优先级的配置覆盖了，实际未生效'
    case 'failed': return '执行失败'
    case 'cancelled': return '已取消'
    default: return application === undefined ? undefined : `未知状态：${application}`
  }
}

//#region 备份 / 回滚

const BACKUP_DIRNAME = '.compat-vet-backup'
/** 备份这些文件：改 profile 可能碰到的全部。 */
const BACKUP_FILES = ['package.json', 'cordis.patch.yml', 'compatibility.json']

/**
 * 备份 profile 里可能被改动的文件。
 * @returns {{dir:string, files:string[]}}
 */
export function backupProfile(profileDir, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const dir = path.join(profileDir, BACKUP_DIRNAME, stamp)
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  for (const name of BACKUP_FILES) {
    const from = path.join(profileDir, name)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(dir, name))
    files.push(name)
  }
  return { dir, files }
}

/** 从备份还原。返回还原了哪些文件。 */
export function restoreBackup(backup, profileDir) {
  const restored = []
  for (const name of backup.files) {
    const from = path.join(backup.dir, name)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(profileDir, name))
    restored.push(name)
  }
  return restored
}

//#endregion

//#region 自己动手的兜底路径（只在没有 pluginManager 的宿主上用）

/** 把某个包名从 bundles 列表里摘掉（纯函数，便于测试）。 */
export function withoutBundle(manifest, packageName) {
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { manifest, removed: false }
  const next = bundles.filter((name) => name !== packageName)
  if (next.length === bundles.length) return { manifest, removed: false }
  return {
    manifest: { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: next } } },
    removed: true,
  }
}

/** 原子写：同目录临时文件 + rename，避免写到一半被读到半截。 */
export function writeFileAtomicSync(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/**
 * 兜底隔离：自己原子写 profile 的 package.json。
 * ⚠️ 绕过了 dsh 的文件锁，只有在宿主没有 `pluginManager` 服务时才会走到这里。
 */
export function quarantineViaManifest(profileDir, packageName) {
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const { manifest: next, removed } = withoutBundle(manifest, packageName)
  if (!removed) return { ok: true, changed: false, note: '它本来就不在 bundles 里，无需改动' }
  writeFileAtomicSync(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`)
  return { ok: true, changed: true, note: '已直接改写 profile 的 package.json（本机没有 pluginManager 服务，未走官方锁）' }
}

/**
 * 兜底装卸：起子进程跑 `dsh plugin ...`（dshmarket 在普通 dsh 上就是这么做的）。
 * @param {{installAnchor:string, profileName:string, home?:string}} location
 * @param {string[]} pluginArgs 例如 `['add','dsh-cost-meter@latest']`
 */
export function runDshPlugin({ installAnchor, profileName, home }, pluginArgs, { timeoutMs = 300_000, env = process.env } = {}) {
  const bin = path.join(path.dirname(installAnchor), 'lib', 'bin.js')
  if (!fs.existsSync(bin)) {
    return Promise.resolve({ ok: false, code: 'no-cli', text: `找不到 dsh 的命令行入口：${bin}` })
  }
  const args = [bin, 'plugin', '--profile', profileName, ...pluginArgs]
  // 刻意只传 DSH_HOME，并让 `--profile` 说话：环境里继承来的 DSH_PROFILE_DIR
  // 可能指向另一个 profile，会和命令行参数打架（本插件在别处也踩过这个坑）。
  const childEnv = { ...env, ...(home === undefined ? {} : { DSH_HOME: home }) }
  delete childEnv.DSH_PROFILE_DIR
  delete childEnv.DSH_PROFILE

  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, code: 'spawn-failed', text: String(error.message ?? error) })
      return
    }
    const timer = setTimeout(() => {
      output += '\n[compat-vet] 超时，已终止'
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: 'spawn-failed', text: String(error.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code === 0 ? undefined : `exit-${code}`, text: output.trim(), exitCode: code })
    })
  })
}

//#endregion

//#region 官方服务路径

/**
 * 走 `pluginManager` 服务执行修复动作。
 *
 * @param {object} manager dsh 的 pluginManager 服务
 * @param {string} action REPAIR_ACTION
 * @param {{name:string, version?:string}} target
 */
export async function repairViaManager(manager, action, target) {
  const { name } = target
  try {
    if (action === REPAIR_ACTION.QUARANTINE) {
      return normalizeOutcome(await manager.setBundleEnabled(name, false))
    }
    if (action === REPAIR_ACTION.UNINSTALL) {
      return normalizeOutcome(await manager.removeBundle(name))
    }
    if (action === REPAIR_ACTION.UPGRADE) {
      return normalizeOutcome(await manager.installBundle(`${name}@latest`))
    }
    return { ok: false, code: 'unknown-action', text: `不认识的动作：${action}` }
  } catch (error) {
    return normalizeOutcome(undefined, error)
  }
}

/**
 * 问 dsh 自己：现在还有哪些 bundle 被判为不兼容。
 *
 * 这是本模块最有力的一招 —— **复检不靠我自己的判断，靠 dsh 自己的判断**。
 * `listBundles()` 的每一行都可能带 `error.code==='incompatible-version'` 与
 * `error.incompatible[]`（含 name / version / runtimeVersion / peers）。
 *
 * @returns {Promise<{available:boolean, items:Array, error?:string}>}
 */
export async function dshVerdictsOf(manager) {
  if (manager === undefined || manager === null) return { available: false, items: [], error: '本机宿主没有 pluginManager 服务' }
  try {
    const rows = await manager.listBundles()
    if (!Array.isArray(rows)) return { available: false, items: [], error: 'listBundles() 返回的不是数组' }
    const items = []
    for (const row of rows) {
      const incompatible = row?.error?.incompatible
      if (!Array.isArray(incompatible) || incompatible.length === 0) continue
      for (const one of incompatible) {
        items.push({
          bundle: row.name,
          code: row.error?.code,
          name: one.name,
          version: one.version,
          runtimeVersion: one.runtimeVersion,
          peers: one.peers,
          enabled: row.enabled,
          removable: row.removable,
          readOnlyReason: row.readOnlyReason,
        })
      }
    }
    return { available: true, items }
  } catch (error) {
    return { available: false, items: [], error: String(error?.message ?? error) }
  }
}

/**
 * dsh 对本进程的重估**不是同步的** —— 采样一次就下结论会把「还没同步」误判成「没修好」。
 * （第一版真机验证正是这么翻的车：一次正确落盘的修复被判失败并回滚。）
 * 所以这里轮询到它不再报这个 bundle 不兼容，或到超时为止。
 */
const SETTLE_TIMEOUT_MS = 6000
const SETTLE_INTERVAL_MS = 400

export async function pollDshVerdict(manager, bundleName, options = {}) {
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? SETTLE_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  let verdicts = await dshVerdictsOf(manager)
  while (verdicts.available && verdicts.items.some((x) => x.bundle === bundleName) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    verdicts = await dshVerdictsOf(manager)
  }
  return verdicts
}

/**
 * 这次改动**真的写进磁盘上的 profile 清单了吗**。
 *
 * 为什么单独做这一层：下次启动读的就是这份清单，它是「100% 避免下次启动失败」
 * 唯一可靠的依据。dsh 服务在本进程里的即时结论只反映当前进程。
 *
 * `dsh.profile.bundles` 允许两种写法（裸包名 / 带 enabled 的对象），两种都认。
 */
export function persistedEffect(profileDir, action, target) {
  const name = typeof target === 'string' ? target : target?.name
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    const dependencies = manifest?.dependencies ?? {}
    const entry = bundles.find((one) => (typeof one === 'string' ? one === name : one?.name === name))
    const stillActive = entry !== undefined && (typeof entry === 'string' || entry.enabled !== false)

    if (action === REPAIR_ACTION.QUARANTINE) {
      return {
        ok: !stillActive,
        detail: stillActive ? '它仍在 dsh.profile.bundles 里' : '已不在 dsh.profile.bundles 里（dsh 不会再加载它）',
      }
    }
    if (action === REPAIR_ACTION.UNINSTALL) {
      const dependencyGone = !Object.hasOwn(dependencies, name)
      const ok = !stillActive && dependencyGone
      return {
        ok,
        detail: ok
          ? '依赖与 bundles 里都已移除'
          : `清单里仍能找到它（${stillActive ? '还在 bundles 里' : ''}${dependencyGone ? '' : '还在 dependencies 里'}）`,
      }
    }
    // 升级：只要求依赖还在（具体版本号由 pnpm 决定，这里不断言，免得把成功误判成失败）
    const present = Object.hasOwn(dependencies, name)
    return {
      ok: present,
      detail: present ? `依赖声明为 ${dependencies[name]}` : '依赖已从清单里消失（异常）',
    }
  } catch (error) {
    return { ok: false, detail: `读不到 profile 清单：${String(error?.message ?? error)}` }
  }
}

//#endregion

/**
 * 修复编排：备份 → 执行 → 复检（我的体检 + dsh 的判定）→ 不过就回滚。
 *
 * @param {object} input
 * @param {string} input.action
 * @param {{name:string, version?:string}} input.target
 * @param {string} input.profileDir
 * @param {string} input.profileName
 * @param {string} input.installAnchor
 * @param {object} [input.manager]  dsh 的 pluginManager 服务（拿不到时退回兜底路径）
 * @param {string} [input.home]
 * @param {(step:string, detail?:string)=>void} [input.onStep] 进度回调
 * @param {() => Promise<object>} [input.reaudit] 复检回调，返回体检结果
 * @param {number} [input.timeoutMs]
 * @returns {Promise<object>} 结构化的修复结果（会被页面直接显示）
 */
export async function repairPlugin(input) {
  const {
    action, target, profileDir, profileName, installAnchor, manager, home,
    onStep = () => {}, reaudit, timeoutMs,
  } = input
  const started = Date.now()
  const steps = []
  const step = (label, detail) => {
    steps.push({ label, detail, at: new Date().toISOString() })
    onStep(label, detail)
  }

  if (!Object.values(REPAIR_ACTION).includes(action)) {
    return { ok: false, action, target, steps, error: `不认识的动作：${action}` }
  }
  if (typeof target?.name !== 'string' || target.name === '') {
    return { ok: false, action, target, steps, error: '没有指明要修哪个插件' }
  }

  // ① 备份
  let backup
  try {
    backup = backupProfile(profileDir)
    step(`已备份 profile 配置`, `${backup.dir}（${backup.files.join('、') || '无可备份文件'}）`)
  } catch (error) {
    return { ok: false, action, target, steps, error: `备份失败，为安全起见没有做任何改动：${error.message}` }
  }

  // ② 执行
  const usedService = manager !== undefined && manager !== null
  let outcome
  if (usedService) {
    step(`调用 dsh 自己的插件服务执行「${ACTION_TEXT[action]}」`, `目标：${target.name}${target.version ? `@${target.version}` : ''}`)
    outcome = await repairViaManager(manager, action, target)
  } else if (action === REPAIR_ACTION.QUARANTINE) {
    step('本机宿主没有 pluginManager 服务，改用直接改写 profile 清单', `目标：${target.name}`)
    try {
      const r = quarantineViaManifest(profileDir, target.name)
      outcome = { ok: r.ok, changed: r.changed, text: r.note }
    } catch (error) {
      outcome = { ok: false, code: 'write-failed', text: String(error.message ?? error) }
    }
  } else {
    step('本机宿主没有 pluginManager 服务，改起子进程跑 dsh 命令', `目标：${target.name}`)
    const args = action === REPAIR_ACTION.UNINSTALL ? ['remove', target.name] : ['add', `${target.name}@latest`]
    outcome = await runDshPlugin({ installAnchor, profileName, home }, args, { timeoutMs })
  }

  if (!outcome.ok) {
    step('执行失败', outcome.text)
    // 失败的写操作可能已经改了一半 —— 用备份还原，保证不留残局
    let rolledBack = false
    try {
      restoreBackup(backup, profileDir)
      rolledBack = true
      step('已用备份还原 profile，环境回到修复前')
    } catch (error) {
      step('回滚也失败了，profile 可能处于中间状态', String(error.message ?? error))
    }
    return {
      ok: false,
      action,
      target,
      steps,
      usedDshService: usedService,
      error: outcome.text,
      errorCode: outcome.code,
      rolledBack,
      tookMs: Date.now() - started,
    }
  }

  step('执行完成', [explainApplication(outcome.application), outcome.text].filter(Boolean).join('；') || undefined)

  // ③ 复检（三层，按可信度从高到低）
  //
  // 第一层：**磁盘上的 profile 清单**。下次启动读的就是它，
  // 所以这一层才是「100% 避免下次启动失败」真正的依据。
  const persisted = persistedEffect(profileDir, action, target)
  step(persisted.ok ? '已确认改动落盘（下次启动读到的就是新状态）' : '改动没有落盘', persisted.detail)

  // 第二层：本插件自己的体检（同样读磁盘上的文件）
  let stillByMe = []
  let reauditReport
  if (typeof reaudit === 'function') {
    try {
      reauditReport = await reaudit()
      stillByMe = (reauditReport?.items ?? []).filter(
        (item) => item.name === target.name && (item.severity === 'block' || item.severity === 'warn'),
      )
    } catch (error) {
      step('复检（本插件体检）没能完成', String(error.message ?? error))
    }
  }
  const clearedByMe = stillByMe.length === 0

  // 第三层：问 dsh 自己 —— **必须轮询**。
  // 第一版真机验证就是在这里翻的车：`setBundleEnabled` 返回的 application 是
  // `restart-required`，本进程的 bundle 表并没有同步更新，我采样一次就下结论，
  // 于是把一次**已经正确落盘的修复**判成失败并回滚了。
  // 「还没同步」与「没修好」是两件完全不同的事，不能混为一谈。
  const verdicts = await pollDshVerdict(manager, target.name)
  const stillByDsh = verdicts.available ? verdicts.items.filter((x) => x.bundle === target.name) : []
  const clearedByDsh = verdicts.available ? stillByDsh.length === 0 : undefined

  if (verdicts.available) {
    step(
      clearedByDsh ? 'dsh 自己复查：这个插件已不再被判为不兼容' : 'dsh 自己复查：本进程内仍报告它不兼容',
      clearedByDsh
        ? undefined
        : `${stillByDsh.map((x) => `${x.name}@${x.version} ↔ dsh ${x.runtimeVersion}`).join('；')}`
          + '（改动已落盘；dsh 对本进程的重估不是同步的，重启后即按新状态加载）',
    )
  } else {
    step('dsh 自己的复查没能进行', verdicts.error)
  }
  if (reauditReport !== undefined) {
    step(clearedByMe ? '本插件复检：0 项问题' : '本插件复检：仍有问题',
      clearedByMe ? undefined : stillByMe.map((x) => x.title).join('；'))
  }

  // 判定依据只有两条：**改动真的落盘了** 且 **本插件的复检干净了**。
  // dsh 在本进程里的即时结论不参与判定 —— 它可能是「还没同步」，而不是「没修好」。
  // 只有「保证消除冲突」的动作才要求这两条都过；升级允许「装了但还不兼容」。
  const mustBeClean = isGuaranteed(action)
  const verified = mustBeClean ? persisted.ok && clearedByMe : clearedByMe
  if (mustBeClean && !verified) {
    let rolledBack = false
    try {
      restoreBackup(backup, profileDir)
      rolledBack = true
      step('复检没通过，已用备份还原 profile')
    } catch (error) {
      step('复检没通过，且回滚失败', String(error.message ?? error))
    }
    return {
      ok: false,
      action, target, steps,
      usedDshService: usedService,
      error: persisted.ok
        ? '修复动作执行完了，但复检没过（冲突仍在或引入了新问题），已回滚'
        : `改动没有落盘（${persisted.detail}），已回滚`,
      rolledBack,
      verified: false,
      persisted: persisted.ok,
      persistedDetail: persisted.detail,
      clearedByDsh,
      clearedByMe,
      tookMs: Date.now() - started,
      backupDir: backup.dir,
    }
  }

  // 保证消除冲突时，「保证」二字要落到一句可核对的话上：清单已改 + 复检为零。
  const restartNote = outcome.application === 'restart-required'
    ? '；dsh 会按新状态加载（重启后一定生效，本进程内是否已重估由 dsh 决定）'
    : ''
  step(
    mustBeClean
      ? '✅ 已确认冲突消除：dsh 下次启动不会再因为这个插件被拦下'
      : `已执行升级；复检${verified ? '通过' : '未通过（新版可能仍不兼容）'}`,
    `${explainApplication(outcome.application) ?? ''}${restartNote}`.replace(/^；/, ''),
  )

  return {
    ok: true,
    action,
    target,
    steps,
    usedDshService: usedService,
    application: outcome.application,
    applicationText: explainApplication(outcome.application),
    /** 改动是否**已经落盘**（下次启动的唯一依据） */
    persisted: persisted.ok,
    persistedDetail: persisted.detail,
    /** dsh 自己的复查结论；undefined = 没能问到它 */
    clearedByDsh,
    clearedByMe,
    verified,
    /** 这个动作是否属于「保证消除冲突」的那一类 */
    guaranteed: isGuaranteed(action),
    tookMs: Date.now() - started,
    backupDir: backup.dir,
    reauditSummary: reauditReport?.summary,
  }
}
