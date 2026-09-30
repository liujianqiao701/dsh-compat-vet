/**
 * 页面与宿主之间的 HTTP 通道。
 *
 * 为什么需要它：客户端插件跑在浏览器里，拿不到 profile 文件，也不能自己跑 pnpm。
 * 所以浏览器只负责**显示和收键盘**，一切判定与改动都在宿主侧完成，通过这两个接口往返。
 *
 * 安全：这是一个**会改 profile 的写接口**，绝不能裸奔。
 * 照抄本机既有两个成熟插件（@liustack/modlens、dshmarket）同款围栏：
 *   ① 拒绝 `sec-fetch-site: cross-site`
 *   ② `Host` 必须是回环地址（DNS 重绑定攻击里，Host 是攻击者页面**伪造不了**的那个头）
 *   ③ 带了 `Origin` 就必须与 `Host` 同源
 * 另外请求体有硬上限（4 KiB），并且只认固定两个 action 常量 —— 不接受任意包名以外的参数。
 */
import process from 'node:process'
import { REPAIR_ACTION, ACTION_TEXT, isGuaranteed, repairPlugin, dshVerdictsOf } from './repair.js'

export const API_PREFIX = '/dsh-compat-doctor/api/v1'
export const STATUS_PATH = `${API_PREFIX}/status`
export const REPAIR_PATH = `${API_PREFIX}/repair`

/** 与 dsh 侧的 webServer 服务同名的注册入口，`kind: 'exact'` 表示精确匹配这条路径。 */
const MAX_BODY_BYTES = 4096
/** 保留最近多少次修复作业，避免长期运行后内存里堆垃圾。 */
const MAX_JOBS = 20

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** 回环地址判定：只认本机。 */
function isLoopbackHost(hostname) {
  if (hostname === 'localhost') return true
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (bare === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/**
 * 本请求是否可信。
 * 导出是为了能被单元测试直接打：这几行是**这个写接口的唯一防线**，必须测得动。
 */
export function isTrustedRequest(request) {
  const host = request?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 读 JSON 请求体，超限即拒。 */
function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        resolve({ ok: false, error: `请求体超过 ${maxBytes} 字节上限` })
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') { resolve({ ok: true, value: {} }); return }
      try {
        const value = JSON.parse(text)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          resolve({ ok: false, error: '请求体必须是一个 JSON 对象' })
          return
        }
        resolve({ ok: true, value })
      } catch (error) {
        resolve({ ok: false, error: `请求体不是合法 JSON：${error.message}` })
      }
    })
    request.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }))
  })
}

//#region 页面载荷

/**
 * 把体检报告压缩成页面真正需要的那点数据。
 *
 * 刻意**不把整份报告丢给浏览器**：报告里有几百行中文说明与全部插件明细，
 * 横幅只需要「哪个插件、什么版本、dsh 什么版本、能做什么」，多传无益。
 */
export function statusPayload({ report, dshVerdicts, profileName, canRepair, repairDisabledReason }) {
  const items = Array.isArray(report?.items) ? report.items : []
  const problems = items
    .filter((item) => item.severity === 'block' || item.severity === 'warn')
    .map((item) => {
      const worst = item.findings?.find((f) => f.severity === item.severity) ?? item.findings?.[0]
      const actions = []
      if (item.inBundles) actions.push(REPAIR_ACTION.QUARANTINE)
      actions.push(REPAIR_ACTION.UNINSTALL, REPAIR_ACTION.UPGRADE)
      return {
        name: item.name,
        version: item.installedVersion ?? null,
        severity: item.severity,
        inBundles: item.inBundles === true,
        affectsRuntime: item.affectsRuntime === true,
        title: worst?.title ?? '存在问题',
        detail: worst?.detail ?? '',
        findings: (item.findings ?? []).map((f) => ({ code: f.code, severity: f.severity, title: f.title, detail: f.detail })),
        actions,
        defaultAction: item.inBundles ? REPAIR_ACTION.QUARANTINE : REPAIR_ACTION.UNINSTALL,
        actionText: Object.fromEntries(actions.map((a) => [a, ACTION_TEXT[a]])),
      }
    })

  return {
    schema: 'dsh-compat-doctor/status/v1',
    generatedAt: new Date().toISOString(),
    profile: profileName ?? null,
    profileDir: report?.profile?.dir ?? null,
    dshVersion: report?.runtimeVersion ?? null,
    nodeVersion: report?.nodeVersion ?? null,
    summary: report?.summary ?? null,
    problems,
    upcoming: Array.isArray(report?.upcoming) ? report.upcoming : [],
    dshVerdicts: dshVerdicts ?? { available: false, items: [] },
    adaptation: report?.adaptation ? {
      verdict: report.adaptation.builtIn?.verdict,
      verdictText: report.adaptation.builtIn?.verdictText,
      deniesAtStartup: report.adaptation.builtIn?.deniesAtStartup,
      exemptionMechanism: report.adaptation.builtIn?.exemptionMechanism,
    } : null,
    error: report?.error,
    canRepair: canRepair === true,
    repairDisabledReason: repairDisabledReason ?? null,
    actions: {
      quarantine: ACTION_TEXT[REPAIR_ACTION.QUARANTINE],
      uninstall: ACTION_TEXT[REPAIR_ACTION.UNINSTALL],
      upgrade: ACTION_TEXT[REPAIR_ACTION.UPGRADE],
    },
  }
}

//#endregion

//#region 修复作业

/**
 * 为什么是「作业」而不是一次同步请求：
 * 升级要跑 pnpm、可能要几分钟，还可能等 profile 文件锁（dsh 默认等 120 秒）。
 * 一次 HTTP 请求吊在那里既容易被超时切断，页面上也没法给进度。
 * 所以 POST 立刻返回 jobId，页面再轮询。
 */
function createJobStore() {
  const jobs = new Map()
  return {
    start(label, runner) {
      const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const job = {
        id,
        label,
        state: 'running',
        steps: [],
        result: undefined,
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
      }
      jobs.set(id, job)
      while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value)
      runner((stepLabel, detail) => {
        job.steps.push({ label: stepLabel, detail, at: new Date().toISOString() })
      })
        .then((result) => {
          job.state = result?.ok === true ? 'done' : 'failed'
          job.result = result
        })
        .catch((error) => {
          job.state = 'failed'
          job.result = { ok: false, error: String(error?.message ?? error) }
        })
        .finally(() => { job.finishedAt = new Date().toISOString() })
      return job
    },
    get(id) { return jobs.get(id) },
  }
}

//#endregion

/**
 * 挂上页面的两个接口。
 *
 * @param {object} input
 * @param {object} input.host 宿主上下文（要有 webServer，且能拿到 pluginManager）
 * @param {(options:{force:boolean}) => Promise<object>} input.getReport 取体检报告
 * @param {string} input.profileDir
 * @param {string} input.profileName
 * @param {string} input.installAnchor
 * @param {string} [input.home]
 * @param {() => object|undefined} input.manager 取 pluginManager（可能一直没有）
 * @returns {Array<() => void>} 释放函数
 */
export function mountDoctorRoutes({ host, getReport, profileDir, profileName, installAnchor, home, manager, log = () => {} }) {
  const jobs = createJobStore()

  const managerOf = () => {
    try {
      return typeof manager === 'function' ? manager() : manager
    } catch {
      return undefined
    }
  }

  const buildStatus = async ({ force = false } = {}) => {
    const report = await getReport({ force })
    const verdicts = await dshVerdictsOf(managerOf())
    const pm = managerOf()
    return statusPayload({
      report,
      dshVerdicts: verdicts,
      profileName,
      canRepair: pm !== undefined && pm !== null,
      repairDisabledReason: pm === undefined || pm === null
        ? '本机宿主没有提供 dsh 的 pluginManager 服务（只有隔离可以走直接改写清单的兜底路径，卸载/升级会改用子进程跑 dsh 命令）'
        : null,
    })
  }

  const disposers = []

  disposers.push(host.webServer.register({
    name: 'dsh-compat-doctor-status',
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { ok: false, error: '只接受来自本机页面的请求（Host 必须是回环地址且与 Origin 同源）' })
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const force = /[?&]force=1/.test(request.url ?? '')
        sendJson(response, 200, await buildStatus({ force }))
      } catch (error) {
        log('status 接口出错', error)
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    name: 'dsh-compat-doctor-repair',
    kind: 'exact',
    path: REPAIR_PATH,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { ok: false, error: '只接受来自本机页面的请求（Host 必须是回环地址且与 Origin 同源）' })
        return
      }

      if (request.method === 'GET') {
        const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id')
        const job = id === null ? undefined : jobs.get(id)
        if (job === undefined) {
          sendJson(response, 404, { ok: false, error: '没有这个修复作业（可能已完成并被清理）' })
          return
        }
        sendJson(response, 200, { ok: true, job })
        return
      }

      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }

      const body = await readJsonBody(request)
      if (!body.ok) {
        sendJson(response, 400, { ok: false, error: body.error })
        return
      }
      const { action, name, version } = body.value
      if (!Object.values(REPAIR_ACTION).includes(action)) {
        sendJson(response, 400, {
          ok: false,
          error: `action 必须是 ${Object.values(REPAIR_ACTION).join(' / ')} 之一`,
        })
        return
      }
      if (typeof name !== 'string' || name.trim() === '' || name.length > 214) {
        sendJson(response, 400, { ok: false, error: 'name 必须是一个合法的包名字符串' })
        return
      }

      const target = { name: name.trim(), version: typeof version === 'string' ? version : undefined }
      const pm = managerOf()
      log(`收到修复请求：${action} ${target.name}`)
      const job = jobs.start(`${action} ${target.name}`, (onStep) => repairPlugin({
        action,
        target,
        profileDir,
        profileName,
        installAnchor,
        home,
        manager: pm,
        onStep,
        reaudit: async () => getReport({ force: true }),
      }))
      sendJson(response, 202, { ok: true, jobId: job.id, action, target, guaranteed: isGuaranteed(action) })
    },
  }))

  return disposers
}
