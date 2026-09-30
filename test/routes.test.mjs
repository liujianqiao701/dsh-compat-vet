/**
 * HTTP 通道的测试。
 *
 * 这里最重要的一组是 **同源围栏**：它是「能改 profile 的写接口」的唯一防线。
 * 围栏写错了不会有任何报错，只会安静地把一个任意网站可触发的改 profile 的接口
 * 暴露在本机上 —— 所以必须逐条断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { REPAIR_PATH, STATUS_PATH, isTrustedRequest, mountDoctorRoutes, statusPayload } from '../lib/routes.js'

function req({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const emitter = new EventEmitter()
  emitter.method = method
  emitter.url = url
  emitter.headers = headers
  // 真 http.IncomingMessage 有 destroy()，读体超限时代码会用它掐掉连接
  emitter.destroy = () => {}
  if (body !== undefined) {
    setImmediate(() => {
      emitter.emit('data', Buffer.from(body))
      emitter.emit('end')
    })
  }
  return emitter
}

function res() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(chunk) { captured.body = chunk === undefined ? '' : String(chunk) },
    json() { return JSON.parse(captured.body) },
  }
}

//#region 同源围栏

test('围栏：本机回环 + 同源 → 放行', () => {
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } }), true)
  assert.equal(isTrustedRequest({ headers: { host: 'localhost:3080' } }), true)
  assert.equal(isTrustedRequest({ headers: { host: '[::1]:3080' } }), true)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true)
  assert.equal(isTrustedRequest({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } }), true)
})

test('围栏：DNS 重绑定（Host 是攻击者伪造不了的那个头）→ 拒绝', () => {
  // 攻击者页面把域名解析到 127.0.0.1，此时 Host 是攻击者的域名
  assert.equal(isTrustedRequest({ headers: { host: 'evil.example:3080' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080' } }), false)
  // 内网地址也不行：本接口只服务本机页面
  assert.equal(isTrustedRequest({ headers: { host: '10.0.0.5:3080' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '192.168.1.9:3080', origin: 'http://192.168.1.9:3080' } }), false)
})

test('围栏：跨站与异源 → 拒绝', () => {
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), false)
  // 端口不同也算异源
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' } }), false)
  // 明确声明跨站
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
  // 同站但非同源，仍按异源处理
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-site' } }), true)
})

test('围栏：缺 Host / 畸形 Host / 畸形 Origin → 拒绝（宁可错杀）', () => {
  assert.equal(isTrustedRequest({ headers: {} }), false)
  assert.equal(isTrustedRequest({ headers: { host: '' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: 'http://' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'not a url' } }), false)
  assert.equal(isTrustedRequest({}), false)
  assert.equal(isTrustedRequest(undefined), false)
})

//#endregion

//#region 载荷

const REPORT = {
  runtimeVersion: '0.2.0-rc.2',
  nodeVersion: '24.16.0',
  profile: { name: 'web', dir: 'C:\\x\\profiles\\web' },
  summary: { total: 9, blocked: 1, warned: 0, ok: 5, info: 3, problems: 1, upcoming: 0 },
  adaptation: { builtIn: { verdict: 'effective', verdictText: '存在且实测有效', deniesAtStartup: true, exemptionMechanism: true } },
  items: [
    {
      name: 'dsh-cost-meter', installedVersion: '1.7.35', inBundles: true, affectsRuntime: true, severity: 'block',
      findings: [{ code: 'peer-incompatible', severity: 'block', title: '与运行时不兼容', detail: '要求 ^0.1.x，当前 0.2.0-rc.2' }],
    },
    {
      name: 'dsh-ask-notify', installedVersion: '1.0.4', inBundles: true, affectsRuntime: true, severity: 'ok',
      findings: [{ code: 'unverifiable', severity: 'ok', title: '无版本声明', detail: '' }],
    },
  ],
  upcoming: [{ name: 'risky', version: '2.0.0', level: 'fragile', levelText: '下一个小版本升级就会不兼容', breaksAt: '0.3.0', where: 'dsh.engines.dsh', range: '~0.2.0', reason: 'dsh 升到 0.3.0 时该范围就不再满足' }],
}

test('载荷：必须同时给出插件版本与 dsh 版本（用户明确要求的）', () => {
  const payload = statusPayload({ report: REPORT, profileName: 'web', canRepair: true })
  assert.equal(payload.dshVersion, '0.2.0-rc.2')
  assert.equal(payload.problems.length, 1, 'ok 级不该进问题清单')
  assert.equal(payload.problems[0].name, 'dsh-cost-meter')
  assert.equal(payload.problems[0].version, '1.7.35')
  assert.equal(payload.problems[0].title, '与运行时不兼容')
  assert.equal(payload.problems[0].defaultAction, 'quarantine', '在 bundles 里的默认动作是隔离（可逆、不需联网）')
  assert.deepEqual(payload.problems[0].actions, ['quarantine', 'uninstall', 'upgrade'])
  assert.equal(payload.upcoming.length, 1)
  assert.equal(payload.canRepair, true)
})

test('载荷：不在 bundles 里的插件默认动作改为卸载（隔离对它没意义）', () => {
  const report = {
    ...REPORT,
    items: [{ ...REPORT.items[0], inBundles: false, affectsRuntime: false }],
    upcoming: [],
  }
  const payload = statusPayload({ report, profileName: 'web', canRepair: true })
  assert.equal(payload.problems[0].defaultAction, 'uninstall')
  assert.deepEqual(payload.problems[0].actions, ['uninstall', 'upgrade'])
})

test('载荷：报告整个炸掉时也能构造出载荷，不抛', () => {
  const payload = statusPayload({ report: { error: '拿不到 profile' }, profileName: 'web', canRepair: false, repairDisabledReason: '没有服务' })
  assert.equal(payload.problems.length, 0)
  assert.equal(payload.upcoming.length, 0)
  assert.equal(payload.error, '拿不到 profile')
  assert.equal(payload.canRepair, false)
  const empty = statusPayload({})
  assert.equal(empty.problems.length, 0)
})

//#endregion

//#region 路由端到端（用假 webServer / 假 req / 假 res 驱动真处理器）

function mount({ manager, getReport } = {}) {
  const registered = []
  const host = { webServer: { register(route) { registered.push(route); return () => {} } } }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpd-routes-'))
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name":"p","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
  const logs = []
  const disposers = mountDoctorRoutes({
    host,
    getReport: getReport ?? (async () => REPORT),
    profileDir,
    profileName: 'web',
    installAnchor: path.join(os.tmpdir(), 'nope', '@deepseek-ai', 'dsh', 'package.json'),
    manager,
    log: (m) => logs.push(m),
  })
  const status = registered.find((r) => r.path === STATUS_PATH)
  const repair = registered.find((r) => r.path === REPAIR_PATH)
  return { status, repair, logs, disposers, profileDir }
}

test('路由：注册的是两条 exact 路径', () => {
  const { status, repair } = mount()
  assert.equal(status.kind, 'exact')
  assert.equal(repair.kind, 'exact')
  assert.equal(status.path, STATUS_PATH)
  assert.equal(repair.path, REPAIR_PATH)
})

test('路由：可信请求能拿到状态，且状态里带着两个版本号', async () => {
  const { status } = mount()
  const response = res()
  await status.handler(req({ headers: { host: '127.0.0.1:3080' } }), response)
  assert.equal(response.captured.status, 200)
  assert.equal(response.captured.headers['cache-control'], 'no-store')
  const body = response.json()
  assert.equal(body.dshVersion, '0.2.0-rc.2')
  assert.equal(body.problems[0].version, '1.7.35')
})

test('路由：不可信请求在读到任何数据之前就被 403 挡下', async () => {
  const { status, repair } = mount()
  for (const [handler, request] of [
    [status.handler, req({ headers: { host: 'evil.example' } })],
    [repair.handler, req({ method: 'POST', headers: { host: 'evil.example' }, body: '{"action":"uninstall","name":"x"}' })],
  ]) {
    const response = res()
    await handler(request, response)
    assert.equal(response.captured.status, 403)
    assert.match(response.json().error, /本机/)
  }
})

test('路由：方法不对给 405，不是 404', async () => {
  const { status, repair } = mount()
  const a = res()
  await status.handler(req({ method: 'POST', headers: { host: '127.0.0.1:1' } }), a)
  assert.equal(a.captured.status, 405)
  assert.equal(a.captured.headers.allow, 'GET')
  const b = res()
  await repair.handler(req({ method: 'PUT', headers: { host: '127.0.0.1:1' } }), b)
  assert.equal(b.captured.status, 405)
})

test('路由：动作/包名非法 → 400，且绝不落到执行路径上', async () => {
  const manager = { calls: [] }
  const { repair } = mount({ manager })
  const cases = [
    [{ action: 'rm-rf', name: 'x' }, /action 必须是/],
    [{ action: 'quarantine' }, /name 必须/],
    [{ action: 'quarantine', name: '' }, /name 必须/],
    [{ action: 'quarantine', name: 'x'.repeat(300) }, /name 必须/],
  ]
  for (const [payload, pattern] of cases) {
    const response = res()
    await repair.handler(
      req({ method: 'POST', headers: { host: '127.0.0.1:1' }, body: JSON.stringify(payload) }),
      response,
    )
    assert.equal(response.captured.status, 400, JSON.stringify(payload))
    assert.match(response.json().error, pattern)
  }
  assert.deepEqual(manager.calls, [], '非法请求不该碰任何服务')
})

test('路由：请求体不是 JSON / 太大 → 400', async () => {
  const { repair } = mount()
  const bad = res()
  await repair.handler(req({ method: 'POST', headers: { host: '127.0.0.1:1' }, body: '{oops' }), bad)
  assert.equal(bad.captured.status, 400)
  assert.match(bad.json().error, /合法 JSON/)

  const huge = res()
  await repair.handler(req({ method: 'POST', headers: { host: '127.0.0.1:1' }, body: `{"action":"${'x'.repeat(9000)}"}` }), huge)
  assert.equal(huge.captured.status, 400)
  assert.match(huge.json().error, /上限/)
})

test('路由：合法修复请求 → 202 + jobId，随后能查到作业与结果', async () => {
  const calls = []
  const manager = {
    async setBundleEnabled(name, enabled) {
      calls.push(['setBundleEnabled', name, enabled])
      return { changed: true, stage: 'enable', target: name, enabled, application: 'applied' }
    },
    async listBundles() { return [] },
  }
  // 修完之后复检必须真的干净 —— 否则按设计就该判失败并回滚（那正是它该做的事）
  const cleanReport = { ...REPORT, items: REPORT.items.filter((item) => item.name !== 'dsh-cost-meter'), upcoming: [] }
  const { repair } = mount({ manager, getReport: async () => cleanReport })
  const started = res()
  await repair.handler(
    req({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, body: '{"action":"quarantine","name":"dsh-cost-meter"}' }),
    started,
  )
  assert.equal(started.captured.status, 202)
  const { jobId, guaranteed } = started.json()
  assert.equal(guaranteed, true)
  assert.equal(typeof jobId, 'string')

  // 轮询到作业结束
  let job
  for (let i = 0; i < 50; i += 1) {
    const poll = res()
    await repair.handler(req({ url: `${REPAIR_PATH}?id=${jobId}`, headers: { host: '127.0.0.1:3080' } }), poll)
    job = poll.json().job
    if (job.state !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(job.state, 'done', JSON.stringify(job, undefined, 2))
  assert.equal(job.result.ok, true)
  assert.equal(job.result.clearedByDsh, true)
  assert.deepEqual(calls, [['setBundleEnabled', 'dsh-cost-meter', false]])
  assert.ok(job.steps.length >= 3, '作业要留下可显示的步骤')

  const missing = res()
  await repair.handler(req({ url: `${REPAIR_PATH}?id=job-nope`, headers: { host: '127.0.0.1:3080' } }), missing)
  assert.equal(missing.captured.status, 404)
})

test('路由：没有 pluginManager 时状态里说明原因，隔离仍可执行', async () => {
  const { status, repair } = mount({ manager: undefined })
  const s = res()
  await status.handler(req({ headers: { host: '127.0.0.1:3080' } }), s)
  assert.equal(s.json().canRepair, false)
  assert.match(s.json().repairDisabledReason, /pluginManager/)

  const started = res()
  await repair.handler(
    req({ method: 'POST', headers: { host: '127.0.0.1:3080' }, body: '{"action":"quarantine","name":"dsh-cost-meter"}' }),
    started,
  )
  assert.equal(started.captured.status, 202)
})
