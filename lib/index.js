/**
 * dsh-compat-vet —— 宿主侧（cordis）插件。
 *
 * 四个动作：
 *   ① 加载时跑一次兼容性体检，有问题就往 stderr 打中文告警（不阻断启动）；
 *   ② 注册 `plugin_compat_check` 工具，让会话里随时能复查；
 *   ③ 注册一个系统提示词段落，把未解决的兼容性问题告诉模型，由它主动提醒用户；
 *   ④ 在 web profile 上挂两条页面接口（并配一个客户端横幅），把「哪个插件的哪个版本
 *      和当前 dsh 的哪个版本冲突」显示在页面上，并让用户用快捷键选择一键修复
 *      （隔离 / 卸载 / 升级）。修复走 dsh 自己的 `pluginManager` 服务，改前备份、
 *      改后复检、复检不过自动回滚 —— 详情见 `repair.js` 与 `routes.js`。
 *
 * 设计红线（这是「体检工具」，不能自己成为故障源）：
 *   · 零 `@deepseek-ai/*` **静态**依赖。`link:` 安装时插件真实路径在 profile 之外，
 *     Node 解析不到 dsh 自带的包（profile 的 node_modules/@deepseek-ai 下只有
 *     cosmokit 与 schemastery），所以工具定义**手写**而不走 `defineTool`。
 *     对 dsh 自身能力的探测走 `adapt.js` 的**动态、可选、可失败** import，
 *     拿不到就降级 —— 静态依赖仍然是零，插件在任何环境下都加载得起来。
 *   · apply() 全程 try/catch，任何异常都只记一行日志，绝不向上抛 —— 否则会拖垮 dsh 启动。
 *   · 客户端横幅手写在 lazy-CJS 协议里，**没有构建步骤**，也不 import 任何 dsh 客户端包。
 *   · profile / dsh 安装位置**多路发现**（ctx → 环境变量 → 自动定位）。
 *     只认 ctx.profileContext 的话，在没有该字段的 dsh 版本上插件会静默什么都不做。
 */
import { auditProfileProbed, auditProfile, syncRuntime, SEVERITY } from './audit.js'
import { renderReport, renderCompact, renderStartupWarning } from './report.js'
import { pickMethod, probeRuntime, resolveContext, serviceOf } from './adapt.js'
import { mountDoctorRoutes } from './routes.js'

export const name = 'dsh-compat-vet'

// 刻意不 inject：本插件要能在「基础设施不全」的环境下也加载起来。
// ctx.get() 拿不到服务时降级，而不是不加载。
export const inject = []

/**
 * 模块加载期就把本机 dsh 的能力探测好（ESM 顶层 await）。
 *
 * 为什么要提前到这里：探测要动态 import，本质是异步的；而启动告警是**同步**写 stderr、
 * 提示词段落也要求同步返回。如果放到 apply() 之后再异步探测，像
 * `dsh web --help` 这种「挂载完就退出」的场景会**来不及打印告警** ——
 * 那就等于在最需要它的时刻失声。
 *
 * 代价只是插件加载慢几十毫秒。探测失败一律置 null，退回保守实现。
 */
let preprobe = null
try {
  const discovered = resolveContext({ config: {}, env: process.env })
  preprobe = await probeRuntime({
    installAnchor: discovered.installAnchor,
    profileDir: discovered.profileDir,
    profileName: discovered.profileName,
  })
  // 探测不到（没 anchor）时留着也没用，置 null 让调用方走保守分支
  if (preprobe?.found !== true) preprobe = null
} catch {
  preprobe = null
}

const TOOL_NAME = 'plugin_compat_check'
const PROMPT_SECTION = 'dsh-compat-vet'
/** 系统提示词里的缓存时长：同一个模型步内不重复读盘。 */
const PROMPT_CACHE_MS = 60_000

/** 注册工具时可尝试的方法名（跨 cordis/dsh 版本容错）。 */
const TOOL_REGISTER_METHODS = ['register', 'defineTool', 'define', 'add']

/** 手写的 JSON Schema（等价于 defineTool 的 parameters 转换结果）。 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    includeOk: {
      type: 'boolean',
      description: '是否连「通过」的插件也列进报告。默认 false，只列有问题的。',
    },
  },
  required: [],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '中文人读报告，含可执行的修复命令。' },
    reportJson: { type: 'string', description: '结构化报告的 JSON 字符串（dsh-compat-vet/v1）。' },
  },
  required: ['text', 'reportJson'],
}

/**
 * 解析出本次体检要用的位置信息。
 * 走 adapt.js 的多路发现，并保留「每一项是从哪来的」以便排查。
 */
function resolveTargets(ctx, config) {
  return resolveContext({ ctx, config })
}

// 探测式体检是异步的（要动态 import dsh 自己的模块），而系统提示词段落要求**同步**返回。
// 所以这里做一层缓存：模块加载期已探测过一次，提示词优先读缓存，读不到退回同步版。
// 按 profileDir 分桶 —— 同一进程里挂多个 profile 时不能互相串味。
const reportCache = new Map()

function cacheEntry(profileDir) {
  let entry = reportCache.get(profileDir)
  if (!entry) {
    entry = { at: 0, report: null, probing: null }
    reportCache.set(profileDir, entry)
  }
  return entry
}

/**
 * 同步体检：用「模块加载期探测好的能力」判定，拿不到就退回保守描述。
 * 这是启动告警与提示词段落的同步路径，保证**一定**出得来。
 *
 * 显式注入 runtime 时**绕过缓存** —— 注入的意义就是要一个确定的结果，
 * 不能被上一次调用留下的缓存盖掉。
 */
function syncReportFor(targets, override) {
  if (!targets?.profileDir) return null
  const runtime = override
    ?? (preprobe && preprobe.anchor === targets.installAnchor ? preprobe : syncRuntime(targets.installAnchor))
  try {
    return auditProfile({ ...targets, runtime })
  } catch {
    return null
  }
}

function cachedReport(targets, override) {
  if (!targets?.profileDir) return null
  if (override !== undefined) return syncReportFor(targets, override)
  const entry = cacheEntry(targets.profileDir)
  if (!entry.report || Date.now() - entry.at >= PROMPT_CACHE_MS) {
    // 后台刷新，本次先用手头的（可能是旧的，也可能要退回同步版）
    void getReport(targets).catch(() => {})
  }
  if (entry.report) return entry.report
  return syncReportFor(targets, override)
}

/** 拿一份体检报告（优先复用缓存，force 时强制重跑）。永不 reject。 */
async function getReport(targets, { force = false, maxAgeMs = PROMPT_CACHE_MS, runtime } = {}) {
  if (!targets?.profileDir) return null
  // 显式注入 runtime 时绕过缓存：注入要的是确定的结果，
  // 既不该被上次的缓存盖掉，也不该污染后续的非注入调用
  if (runtime !== undefined) {
    try {
      return await auditProfileProbed({ ...targets, runtime })
    } catch (error) {
      return errorReport(targets, error)
    }
  }
  const entry = cacheEntry(targets.profileDir)
  const fresh = entry.report && Date.now() - entry.at < maxAgeMs
  if (!force && fresh) return entry.report
  if (entry.probing) return entry.probing
  entry.probing = auditProfileProbed(targets)
    .then((report) => {
      entry.report = report
      entry.at = Date.now()
      return report
    })
    .catch((error) => {
      const report = errorReport(targets, error)
      entry.report = report
      entry.at = Date.now()
      return report
    })
    .finally(() => { entry.probing = null })
  return entry.probing
}

/** 体检整个炸掉时，返回一份「如实说明没做成」的报告，而不是抛给调用方。 */
function errorReport(targets, error) {
  return {
    schema: 'dsh-compat-vet/v1',
    checkedAt: new Date().toISOString(),
    runtimeVersion: null,
    profile: { name: targets?.profileName, dir: targets?.profileDir },
    items: [],
    summary: { total: 0, blocked: 0, warned: 0, ok: 0, info: 0, bundleIssues: 0, problems: 0 },
    error: msgOf(error),
  }
}

/**
 * cordis 插件入口。
 * @param {object} ctx cordis Context
 * @param {object} [config] 来自 cordis.patch.yml 的 config 段
 */
export function apply(ctx, config = {}) {
  const settings = {
    warnOnStartup: config.warnOnStartup !== false,
    promptSection: config.promptSection !== false,
    tool: config.tool !== false,
    pageUi: config.pageUi !== false,
    ...config,
  }
  // 允许显式注入运行时描述（测试与高级用法用），否则用模块加载期探测的结果
  const runtimeOverride = config.runtime

  // ---- ① 启动自检（**同步**，保证一定打印得出来）----
  if (settings.warnOnStartup) {
    try {
      const targets = resolveTargets(ctx, settings)
      if (!targets.profileDir) {
        process.stderr.write(
          'dsh-compat-vet: 拿不到 profile 位置（ctx.profileContext 与环境变量都没有），跳过启动自检。'
          + '如需手动检查请运行 `dsh-compat-vet --profile <名字>`。\n',
        )
      } else {
        const report = syncReportFor(targets, runtimeOverride)
        if (report === null) {
          process.stderr.write('dsh-compat-vet: 启动自检未能取到 profile，已跳过。\n')
        } else if (report.error) {
          process.stderr.write(`dsh-compat-vet: 体检未完成 —— ${report.error}\n`)
        } else {
          const warning = renderStartupWarning(report)
          if (warning) process.stderr.write(`${warning}\n`)
        }
        // 顺手做一次完整探测，灌进缓存供工具与提示词段落使用（不阻塞启动）
        void getReport(targets, { force: true }).catch(() => {})
      }
    } catch (error) {
      process.stderr.write(`dsh-compat-vet: 启动自检异常（已忽略，不影响 dsh）—— ${msgOf(error)}\n`)
    }
  }

  // ---- ② 系统提示词段落：让模型主动提醒用户 ----
  if (settings.promptSection) {
    try {
      const systemPrompt = serviceOf(ctx, 'systemPrompt')
      const section = pickMethod(systemPrompt, ['section'])
      if (section === undefined) {
        process.stderr.write('dsh-compat-vet: 当前 dsh 没有可用的系统提示词服务，'
          + '跳过提示词段落注册（工具与启动告警不受影响）。\n')
      } else {
        section.fn({
          name: PROMPT_SECTION,
          // 放在靠后位置，避免插进其它段落中间；带醒目标题，位置影响不大。
          order: 900,
          interpolate: false,
          text: () => {
            try {
              const report = cachedReport(resolveTargets(ctx, settings), runtimeOverride)
              if (!report || report.error) return ''
              const blocking = (report.items ?? []).filter(
                (i) => i.severity === SEVERITY.BLOCK || i.severity === SEVERITY.WARN,
              )
              if (blocking.length === 0) return '' // 空段落会被丢弃，不占用上下文
              // 后果描述必须与**实测到的机制**一致：在没有生效预检的 dsh 版本上，
              // 说「已被拒绝加载」是错的 —— 它会照常加载，风险更大
              const denies = report.adaptation?.builtIn?.deniesAtStartup
              const lines = [
                '## DSH 插件兼容性问题（由 dsh-compat-vet 自动检测）',
                '',
                `当前 dsh 运行时为 ${report.runtimeVersion}。以下已安装插件存在版本兼容性问题，`
                + '**在用户询问插件、报错、或功能异常时请主动提醒**：',
                '',
              ]
              for (const item of blocking) {
                const head = item.findings.find((f) => f.severity === SEVERITY.BLOCK) ?? item.findings[0]
                lines.push(`- ${item.name}@${item.installedVersion ?? '?'}：${head.title}`)
                if (item.severity === SEVERITY.BLOCK) {
                  lines.push(denies === true
                    ? '  （该插件已被 dsh 启动预检拒绝加载，功能不会生效）'
                    : denies === false
                      ? '  （实测本机这个 dsh 不会拦下它，插件会照常加载，风险直接暴露在运行时）'
                      : '  （本次未能实测本机 dsh 会不会拦下它）')
                }
              }
              lines.push('')
              lines.push('需要完整报告与修复命令时，调用 `plugin_compat_check` 工具。')
              return lines.join('\n')
            } catch {
              return '' // 提示词段落绝不能因为体检失败而中断
            }
          },
        })
      }
    } catch (error) {
      process.stderr.write(`dsh-compat-vet: 注册系统提示词段落失败（已忽略）—— ${msgOf(error)}\n`)
    }
  }

  // ---- ③ 注册工具 ----
  if (settings.tool) {
    try {
      const tools = serviceOf(ctx, 'tools')
      const register = pickMethod(tools, TOOL_REGISTER_METHODS)
      if (register === undefined) {
        process.stderr.write('dsh-compat-vet: 当前 dsh 的 tools 服务没有可用的注册方法'
          + `（试过 ${TOOL_REGISTER_METHODS.join('/')}），跳过工具注册。`
          + '启动告警与命令行不受影响。\n')
      } else {
        register.fn({
          name: TOOL_NAME,
          description:
            '检查已安装的 DSH 插件与当前 dsh 版本是否冲突/不兼容，输出中文报告与升级、卸载、'
            + '版本豁免的具体命令。它会额外发现 dsh 自身兼容性预检查不到的问题'
            + '（非标准位置的 dsh 版本声明、完全没有 peerDependencies 的插件、'
            + 'bundles 里引用但没装的包、装了却没启用的插件等）。'
            + '当用户反馈插件功能异常、dsh 启动异常，或刚升级 dsh/安装过插件时使用。',
          parameters: PARAMETERS,
          output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: String(value.text) }],
          },
          async execute(args) {
            const targets = resolveTargets(ctx, settings)
            if (!targets.profileDir) {
              throw new Error(
                '无法定位 profile 目录：ctx.profileContext 与环境变量里都没有。'
                + '请在插件配置里显式给出 profileDir，或改用命令行 `dsh-compat-vet --profile <名字>`。',
              )
            }
            // 工具调用是异步的，正好可以每次都做**完整探测 + 实测校准**
            const report = await getReport(targets, { force: true, runtime: runtimeOverride })
            if (!report) throw new Error('兼容性体检未能完成：拿不到 profile 目录')
            if (report.error) throw new Error(`兼容性体检未能完成：${report.error}`)
            const text = renderReport(report, { includeOk: args?.includeOk === true })
            return { text, reportJson: JSON.stringify(report) }
          },
          presentCall() {
            return { card: 'generic', title: '检查 DSH 插件兼容性', kind: 'read' }
          },
          presentResult(_args, result) {
            return {
              card: 'generic',
              title: 'DSH 插件兼容性体检',
              ...(result.isError ? { kind: 'error' } : {}),
            }
          },
          // 只读操作，不修改任何状态，可与其他调用并行
          isConcurrencySafe: () => true,
        })
      }
    } catch (error) {
      process.stderr.write(`dsh-compat-vet: 注册 ${TOOL_NAME} 工具失败（已忽略）—— ${msgOf(error)}\n`)
    }
  }

  // ---- ④ 页面接口：结论上页面，并把用户的一键修复选择送回宿主执行 ----
  if (settings.pageUi) {
    try {
      // 拿不到 ctx.inject 就**安静降级**（老 cordis），不打日志：
      // 这不是异常，本插件的体检、工具、命令行都不受影响，没必要每次启动都刷一行。
      if (typeof ctx.inject === 'function') {
        // `webServer` 只存在于 web profile，而本 cordis 没有「可选注入」写法，
        // 所以用一个作用域注入来挂路由 —— 与 @liustack/modlens 同款写法。
        // 注意本插件自身 inject=[]：拿不到 webServer 时**不加载的只有页面接口**，
        // 体检与命令行照常工作。
        ctx.inject(['webServer'], (scope) => {
          try {
            const targets = resolveTargets(ctx, settings)
            if (!targets.profileDir) {
              process.stderr.write('dsh-compat-vet: 拿不到 profile 目录，跳过页面接口注册。\n')
              return
            }
            const disposers = mountDoctorRoutes({
              host: scope,
              getReport: (options = {}) => getReport(targets, { ...options, runtime: runtimeOverride }),
              profileDir: targets.profileDir,
              profileName: targets.profileName,
              installAnchor: targets.installAnchor,
              home: targets.home,
              // 刻意**延迟**取服务：本插件 apply() 时 pluginManager 可能还没建好，
              // 而页面请求是之后才来的，那时候服务一定在。
              manager: () => serviceOf(scope, 'pluginManager') ?? serviceOf(ctx, 'pluginManager'),
              log: (message, error) => process.stderr.write(
                `dsh-compat-vet: ${message}${error === undefined ? '' : ` —— ${msgOf(error)}`}\n`,
              ),
            })
            if (typeof scope.effect === 'function') {
              scope.effect(() => () => {
                for (const dispose of disposers) {
                  try { dispose() } catch { /* 释放失败不影响退出 */ }
                }
              }, 'dsh-compat-vet: page routes')
            }
          } catch (error) {
            process.stderr.write(`dsh-compat-vet: 挂载页面接口失败（已忽略，不影响 dsh）—— ${msgOf(error)}\n`)
          }
        })
      }
    } catch (error) {
      process.stderr.write(`dsh-compat-vet: 注册页面接口失败（已忽略）—— ${msgOf(error)}\n`)
    }
  }
}

/** 供独立 CLI 复用。 */
export { auditProfile, auditProfileProbed, renderReport, renderCompact, renderStartupWarning }

function msgOf(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
