/**
 * 报告渲染：把 audit.js 的结构化结果转成
 *   ① 中文人读报告（CLI / 启动告警）
 *   ② 可直接复制执行的修复命令
 *   ③ 给模型的紧凑 JSON
 */
import { SEVERITY, FINDING } from './audit.js'

/** 严重度 → 中文标签。 */
const LABEL = {
  [SEVERITY.BLOCK]: '[阻断]',
  [SEVERITY.WARN]: '[警告]',
  [SEVERITY.INFO]: '[提示]',
  [SEVERITY.OK]: '[通过]',
}

/**
 * 生成针对某一条目的修复命令。
 * @param {object} item audit 报告里的 item
 * @param {{profileName:string, runtimeVersion:string|null}} ctx
 * @returns {{label:string, command:string, note?:string}[]}
 */
export function remediesFor(item, ctx) {
  const p = ctx.profileName || 'web'
  const out = []
  const key = item.installedVersion ? `${item.manifestName || item.name}@${item.installedVersion}` : undefined

  const blocked = item.findings.some((f) => f.severity === SEVERITY.BLOCK)

  if (item.findings.some((f) => f.code === FINDING.BUNDLE_UNRESOLVED)) {
    out.push({
      label: '把缺的包装上',
      command: `dsh plugin --profile ${p} add ${item.name}`,
      note: '装完确认它同时出现在 profile package.json 的 dependencies 与 dsh.profile.bundles 两处。',
    })
    out.push({
      label: '或者从 bundles 列表里摘掉它',
      command: `# 编辑 ${p} profile 的 package.json，从 dsh.profile.bundles 数组中删除 "${item.name}"`,
      note: '不用的包就别留在 bundles 里，否则每次启动都会打印 skipping。',
    })
    return out
  }

  if (item.findings.some((f) => f.code === FINDING.DEPENDENCY_NOT_ACTIVE)) {
    out.push({
      label: '启用它（加进 bundles）',
      command: `dsh plugin --profile ${p} add ${item.name}`,
      note: '重装会重新对齐 bundles；或手工把包名加进 dsh.profile.bundles。',
    })
    out.push({
      label: '不用了就卸掉',
      command: `dsh plugin --profile ${p} remove ${item.name}`,
    })
    return out
  }

  if (item.findings.some((f) => f.code === FINDING.MANIFEST_MISSING)) {
    out.push({
      label: '重装以修复安装元数据',
      command: `dsh plugin --profile ${p} install`,
      note: '先重装依赖树；仍读不到清单说明包本身损坏。',
    })
    out.push({
      label: '或者卸载',
      command: `dsh plugin --profile ${p} remove ${item.name}`,
    })
    return out
  }

  if (blocked || item.findings.some((f) => f.code === FINDING.DECLARED_RANGE_INCOMPATIBLE)) {
    out.push({
      label: '① 升级到支持当前 dsh 的版本（首选）',
      command: `dsh plugin --profile ${p} add ${item.name}@latest`,
      note: `装完再跑一次 dsh-compat-vet 确认 ${item.name} 已经变为通过。`,
    })
    out.push({
      label: '② 降级插件到兼容版本',
      command: `dsh plugin --profile ${p} add ${item.name}@<兼容版本>`,
      note: '具体装哪个版本要问插件作者或看它的 release notes。',
    })
    out.push({
      label: '③ 不用了就卸载',
      command: `dsh plugin --profile ${p} remove ${item.name}`,
      note: '卸载后记得确认它已从 dsh.profile.bundles 中消失。',
    })
    // 豁免这条路只有**本机 dsh 确实有豁免机制**时才给 —— 在 0.1.1/0.1.5 这类
    // 没有 compatibility.json 的版本上给这条命令，等于指一条走不通的路
    const hasExemption = ctx.builtIn?.determined !== true || ctx.builtIn?.exemptionMechanism === true
    if (blocked && key && ctx.runtimeVersion && hasExemption) {
      out.push({
        label: '④ 明知有风险仍要强制启用（不推荐）',
        command: `dsh plugin --profile ${p} allow-version ${key} --dsh-version ${ctx.runtimeVersion} --accept-risk`,
        note: '这会让 dsh 放行**这一个精确版本组合**，兼容性问题并没有解决，'
          + '可能表现为功能异常、崩溃或数据损坏。升级 dsh 后该豁免自动失效。',
      })
    }
    if (blocked && ctx.builtIn?.determined === true && ctx.builtIn.deniesAtStartup === false) {
      out.push({
        label: '⚠️ 注意：本机这个 dsh 不会拦下它',
        command: '# 不处理也能启动，但风险直接暴露在运行时',
        note: '实测本机 dsh 没有生效的兼容性预检，所以它会照常加载 —— '
          + '升级 / 降级 / 卸载是仅有的三条正路，**没有「豁免」这条捷径可走**。',
      })
    }
    return out
  }

  out.push({
    label: '需要人工确认',
    command: '# 该插件未声明 dsh 版本要求，请查看其 release notes 或联系作者确认兼容性',
  })
  return out
}

/** 统计一份报告里各严重度的条目。 */
function flattenFindings(items) {
  const byCode = new Map()
  for (const item of items) {
    for (const f of item.findings) {
      if (!byCode.has(f.code)) byCode.set(f.code, [])
      byCode.get(f.code).push({ item, finding: f })
    }
  }
  return byCode
}

/**
 * 渲染中文人读报告。
 * @param {object} report auditProfile 的返回值
 * @param {{includeOk?:boolean, includeInfo?:boolean, color?:boolean}} [options]
 * @returns {string}
 */
export function renderReport(report, options = {}) {
  const { includeOk = false, includeInfo = true } = options
  const lines = []
  const ctx = { profileName: report.profile?.name, runtimeVersion: report.runtimeVersion }
  const s = report.summary ?? {}

  lines.push('DSH 插件兼容性体检报告')
  lines.push('='.repeat(64))
  lines.push(`profile      : ${report.profile?.name ?? '(未知)'}`)
  lines.push(`profile 目录 : ${report.profile?.dir ?? '(未知)'}`)
  lines.push(`dsh 运行时    : ${report.runtimeVersion ?? '(读不到)'}`)
  lines.push(`Node         : ${report.nodeVersion ?? '(未知)'}`)
  lines.push(`检查时间      : ${report.checkedAt}`)
  lines.push(`插件条目      : ${s.total ?? 0}（阻断 ${s.blocked ?? 0} / 警告 ${s.warned ?? 0}`
    + ` / 提示 ${s.info ?? 0} / 通过 ${s.ok ?? 0}）`)

  if (report.error) {
    lines.push('')
    lines.push(`!! 体检自身出错：${report.error}`)
    lines.push('   （这不代表插件没问题，只代表本次没能完成检查。）')
  }

  if ((s.problems ?? 0) === 0 && (s.bundleIssues ?? 0) === 0) {
    lines.push('')
    lines.push('结论：没有发现兼容性问题。')
  } else {
    lines.push('')
    lines.push(`结论：发现 ${s.problems ?? 0} 项需要处理的兼容性问题`
      + `${(s.bundleIssues ?? 0) > 0 ? `，另有 ${s.bundleIssues} 个 bundle 无法解析` : ''}。`)
  }

  if (report.profile?.compatibilityWarnings?.length) {
    lines.push('')
    lines.push('compatibility.json 自身的问题：')
    for (const w of report.profile.compatibilityWarnings) lines.push(`  - ${w}`)
  }

  // 适配信息：让用户看清这次的结论是「按本机实测校准出来的 dsh 能力」判的，
  // 还是「没能实测、按保守假设」判的 —— 结论的可信度从哪来必须写明白
  const a = report.adaptation
  if (a) {
    lines.push('')
    lines.push('-'.repeat(64))
    lines.push('适配信息（结论依据，不是假设）')
    lines.push(`  dsh 版本      : ${a.version ?? '(读不到)'}｜来源：${a.versionSource}`)
    lines.push(`  能力探测      : ${a.appBootProbed
      ? '成功 —— 已就本机这个 dsh 实测校准'
      : `未成功（${a.appBootReason ?? '未探测'}）—— 退回自包含实现`}`)
    lines.push(`  兼容性预检    : ${a.builtIn.verdictText}`)
    if (a.builtIn.determined) {
      lines.push(`    · 会因 peer 不匹配拦下插件 : ${a.builtIn.seesPeerMismatch ? '会' : '不会'}`)
      lines.push(`    · 会检查没有 peer 的插件   : ${a.builtIn.seesPeerlessPlugin ? '会' : '不会（盲区）'}`)
      lines.push(`    · 会看非标准版本声明       : ${a.builtIn.seesDeclaredRange ? '会' : '不会（盲区）'}`)
      lines.push(`    · 版本豁免机制             : ${a.builtIn.exemptionMechanism
        ? `有（${a.compatibilityFilename}）`
        : '没有（本机这个 dsh 版本不支持 allow-version）'}`)
    } else {
      lines.push('    · 未能实测，因此所有「dsh 会不会发现」的标注都是「未实测，不下断言」')
    }
    lines.push(`  自带 bundle   : 由 dsh 安装提供（scope=${a.scope ?? '(未探测)'}）`)
    for (const note of a.notes ?? []) lines.push(`  · ${note}`)
  }

  const shouldShow = (item) => item.severity === SEVERITY.BLOCK
    || item.severity === SEVERITY.WARN
    || (includeInfo && item.severity === SEVERITY.INFO)
    || (includeOk && item.severity === SEVERITY.OK)

  for (const item of report.items ?? []) {
    if (!shouldShow(item)) continue
    lines.push('')
    lines.push('-'.repeat(64))
    lines.push(`${LABEL[item.severity]} ${item.name}`
      + `${item.installedVersion ? ` @ ${item.installedVersion}` : ' (未安装/未解析)'}`)
    const facts = []
    if (item.declaredSpec) facts.push(`声明 ${item.declaredSpec}`)
    facts.push(`来源 ${item.resolver}`)
    facts.push(item.inBundles ? '在 bundles 中（会加载）' : '不在 bundles 中（不加载）')
    lines.push(`         ${facts.join(' | ')}`)

    for (const f of item.findings) {
      lines.push('')
      lines.push(`  ${LABEL[f.severity]} ${f.title}`)
      lines.push(`         ${f.detail}`)
      lines.push(`         [dsh 内置检查：${{
        covered: '同样会发现',
        'not-covered': '不会发现',
      }[f.dshBuiltIn] ?? '会不会发现未实测，不下断言'}${f.dshBuiltInSource ? `｜依据：${f.dshBuiltInSource}` : ''}]`)
    }

    const remedies = remediesFor(item, ctx)
    if (remedies.length > 0) {
      lines.push('')
      lines.push('  处理办法：')
      for (const r of remedies) {
        lines.push(`    · ${r.label}`)
        lines.push(`      ${r.command}`)
        if (r.note) lines.push(`      └ ${r.note}`)
      }
    }
  }

  // 「dsh 内置检查不会发现」的汇总 —— 本插件相对 dsh 自有机制的价值所在
  const byCode = flattenFindings(report.items ?? [])
  const notCovered = [...byCode.entries()]
    .filter(([, list]) => list.some(({ finding }) => finding.dshBuiltIn === 'not-covered'))
  if (notCovered.length > 0) {
    lines.push('')
    lines.push('='.repeat(64))
    lines.push('其中 dsh 自身的兼容性预检**不会**发现的问题类型：')
    for (const [code, list] of notCovered) {
      const names = [...new Set(list.map(({ item }) => item.name))].join(', ')
      lines.push(`  · ${code}（${list.length} 处）：${names}`)
    }
    lines.push(`  —— ${report.adaptation?.builtIn?.verdict === 'absent'
      ? '实测本机 dsh 这个版本**没有**兼容性预检函数，所以上面这些它一个都不会报。'
      : '实测本机 dsh 的预检只查 peerDependencies 里 dsh 相关的键，'
        + '且插件完全没有 peerDependencies 时会直接判定为兼容。'}`)
  }

  // 没能实测的那部分单独说 —— 不确定就说不确定，不含糊过去
  const unknown = [...byCode.entries()]
    .filter(([, list]) => list.some(({ finding }) => finding.dshBuiltIn === 'unknown'))
  if (unknown.length > 0) {
    lines.push('')
    lines.push('以下问题「dsh 自己会不会发现」本次**未能实测确认**（未定位到 dsh 安装目录或能力探测失败）：')
    for (const [code, list] of unknown) {
      const names = [...new Set(list.map(({ item }) => item.name))].join(', ')
      lines.push(`  · ${code}（${list.length} 处）：${names}`)
    }
    lines.push('  —— 传 --anchor <dsh 的 package.json> 可让本次检查实测校准后再下结论。')
  }

  return lines.join('\n')
}

/**
 * 启动时打印的一行/多行紧凑告警（只报阻断与警告，避免刷屏）。
 * @param {object} report
 * @returns {string|null} 没有问题返回 null
 */
export function renderStartupWarning(report) {
  const problems = (report.items ?? []).filter(
    (i) => i.severity === SEVERITY.BLOCK || i.severity === SEVERITY.WARN,
  )
  if (problems.length === 0 && (report.summary?.bundleIssues ?? 0) === 0) return null
  const ctx = { profileName: report.profile?.name, runtimeVersion: report.runtimeVersion }
  const lines = [
    `dsh-compat-vet: 检测到 ${problems.length} 个插件与 dsh ${report.runtimeVersion ?? '?'} 存在兼容性问题：`,
  ]
  for (const item of problems) {
    const head = item.findings.find((f) => f.severity === SEVERITY.BLOCK)
      ?? item.findings.find((f) => f.severity === SEVERITY.WARN)
    lines.push(`  ${LABEL[item.severity]} ${item.name}@${item.installedVersion ?? '?'} — ${head?.title ?? ''}`)
    const first = remediesFor(item, ctx)[0]
    if (first) lines.push(`      建议：${first.command}`)
  }
  lines.push('  完整报告：运行 `dsh-compat-vet`，或在会话里用 plugin_compat_check 工具。')
  return lines.join('\n')
}

/**
 * 给模型的紧凑文本（工具输出用）。
 * @param {object} report
 * @returns {string}
 */
export function renderCompact(report) {
  const s = report.summary ?? {}
  const head = `dsh ${report.runtimeVersion} | profile ${report.profile?.name} | `
    + `${s.total} 个条目：阻断 ${s.blocked}，警告 ${s.warned}，提示 ${s.info}，通过 ${s.ok}`
  const lines = [head]
  for (const item of report.items ?? []) {
    if (item.severity === SEVERITY.OK) continue
    lines.push(`- [${item.severity}] ${item.name}@${item.installedVersion ?? '?'}：`
      + item.findings.map((f) => f.title).join('；'))
  }
  if (report.error) lines.push(`!! 体检自身出错：${report.error}`)
  return lines.join('\n')
}
