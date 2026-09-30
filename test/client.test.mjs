/**
 * 客户端横幅的测试。
 *
 * 这里跑的是**真正的 `lib/client.js`**，只是把它赖以生存的浏览器环境换成一套最小假 DOM。
 * 理由：这一段代码决定用户在页面上看见什么、按键会触发什么，而它平时跑在浏览器里、
 * 我们没法在 CI 里开浏览器 —— 那就把环境伪造到足够真，让真代码自己跑一遍。
 *
 * 断言的重点正是用户提的硬要求：
 *   · 横幅里**必须同时出现插件版本号和 dsh 版本号**；
 *   · 键盘选择**必须能在不干扰输入框打字**的前提下生效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 假 DOM 与加载器在 scripts/helpers/fake-dom.mjs —— 与 scripts/preview-banner.mjs 共用一份，
// 免得「测试里的假浏览器」和「预览工具里的假浏览器」慢慢长歪。
// 放在 scripts/ 而不是 test/ 的原因：`files` 只发布 lib/ 与 scripts/，
// 放 test/ 的话别人装到的包里 preview-banner.mjs 会 import 到一个不存在的文件。
import { CLIENT_FILE, FakeElement, makeDom, loadClient, keyEvent, clickTarget, flush } from '../scripts/helpers/fake-dom.mjs'

const STATUS = {
  schema: 'dsh-compat-doctor/status/v1',
  dshVersion: '0.2.0-rc.2',
  profile: 'web',
  summary: { blocked: 1, warned: 0, problems: 1 },
  adaptation: { deniesAtStartup: true },
  problems: [{
    name: 'dsh-cost-meter',
    version: '1.7.35',
    severity: 'block',
    inBundles: true,
    title: '与运行时不兼容',
    detail: '要求 ^0.1.x，当前 0.2.0-rc.2',
    actions: ['quarantine', 'uninstall', 'upgrade'],
    defaultAction: 'quarantine',
  }],
  upcoming: [],
  canRepair: true,
}

/** 按 URL 分派的 fetch 桩，并记录全部调用。 */
function fakeFetch({ status = STATUS, jobState = 'done', jobResult } = {}) {
  const calls = []
  const impl = (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body })
    let payload
    if (url.includes('/status')) payload = status
    else if (options.method === 'POST') payload = { ok: true, jobId: 'job-1', guaranteed: true }
    else {
      payload = {
        ok: true,
        job: {
          id: 'job-1',
          state: jobState,
          steps: [{ label: '已备份 profile 配置' }, { label: '调用 dsh 自己的插件服务' }],
          result: jobResult ?? { ok: true, target: { name: 'dsh-cost-meter' }, applicationText: '已在本进程立即生效，不需要重启 dsh', clearedByDsh: true, guaranteed: true },
        },
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
  }
  impl.calls = calls
  return impl
}

test('客户端：横幅同时写明插件版本号与 dsh 版本号（用户硬要求）', async () => {
  const dom = makeDom()
  const exports = await loadClient({ dom, fetchImpl: fakeFetch() })
  exports.apply()
  await flush()

  const banner = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.ok(banner, '有问题时必须挂出横幅')
  const html = banner.innerHTML
  assert.match(html, /dsh-cost-meter/, '必须点名是哪个插件')
  assert.match(html, /1\.7\.35/, '必须写明插件版本号')
  assert.match(html, /0\.2\.0-rc\.2/, '必须写明当前 dsh 版本号')
  assert.match(html, /拒绝加载/, '必须说清后果')
  assert.match(html, /与运行时不兼容/, '必须给出原因')
  assert.equal(exports.__test.state.bindings['1'], 'quarantine', '按键 1 = 默认动作（隔离）')
  assert.equal(exports.__test.state.bindings['2'], 'uninstall')
  assert.equal(exports.__test.state.bindings['3'], 'upgrade')
})

test('客户端：修复成功但 dsh 本进程还没重估 → 仍然是绿色成功（不能被旧结论带偏）', async () => {
  // 真机实测：setBundleEnabled 之后 listBundles() 还会报一阵旧结论。
  // 那时若把横幅画成红的「未完成」，用户明明修好了却看到报错 —— 这条测试锁住这个行为。
  const dom = makeDom()
  const impl = fakeFetch({
    jobResult: {
      ok: true,
      target: { name: 'dsh-cost-meter' },
      application: 'restart-required',
      applicationText: '需要重启 dsh 才生效',
      persisted: true,
      clearedByDsh: false,
      clearedByMe: true,
      verified: true,
      guaranteed: true,
    },
  })
  const exports = await loadClient({ dom, fetchImpl: impl })
  exports.apply()
  await flush()

  exports.__test.onKeyDown(keyEvent('1'))
  await flush()
  await flush()
  await flush()

  assert.equal(exports.__test.state.flash.ok, true, '已验证修复就必须是成功态')
  const banner = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.match(banner.innerHTML, /✅ 已处理/)
  assert.match(banner.innerHTML, /改动已写入 profile 配置/, '要如实说明 dsh 还没重估这件事')
  assert.ok(!/❌/.test(banner.innerHTML), '不能出现失败标记')
})

test('客户端：有阻断问题时，「快要不适配」的预警也不能被盖住（可切换查看）', async () => {
  // 真机上就是这样：dsh-cost-meter 阻断 + dshmarket 会在 dsh 0.3.0 失配。
  // 只显示前者等于把用户最想提前知道的那条消息藏起来了。
  const dom = makeDom()
  const status = {
    ...STATUS,
    upcoming: [
      { name: 'dshmarket', version: '1.66.6', level: 'fragile', levelText: '下一个小版本升级就会不兼容', breaksAt: '0.3.0', reason: 'dsh 升到 0.3.0 时该范围就不再满足' },
    ],
  }
  const exports = await loadClient({ dom, fetchImpl: fakeFetch({ status }) })
  exports.apply()
  await flush()

  const banner = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.match(banner.innerHTML, /dsh-cost-meter/, '先给更紧急的（阻断）那条')
  assert.match(banner.innerHTML, /dshmarket/, '预警也必须出现在同一屏')
  assert.match(banner.innerHTML, /0\.3\.0/, '要说清坏在哪个版本')
  assert.match(banner.innerHTML, /升级 dsh 之后会被拒绝加载/, '要说清"现在还能用、以后会坏"')
  assert.equal(exports.__test.state.bindings['1'], 'quarantine', '阻断那条仍然是主操作')

  // 点「查看 / 预防性处理」→ 切到预警视图
  dom.document.fire('click', { target: clickTarget('data-dpd-showpre'), preventDefault() {}, stopPropagation() {} })
  const warn = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.match(warn.innerHTML, /升级预警/, '切过去要显示预警视图')
  assert.match(warn.innerHTML, /dshmarket/)
  assert.match(warn.innerHTML, /data-dpd-showproblems/, '要有返回冲突问题的入口')

  // 再切回来
  dom.document.fire('click', { target: clickTarget('data-dpd-showproblems'), preventDefault() {}, stopPropagation() {} })
  const back = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.match(back.innerHTML, /插件冲突/)
  assert.match(back.innerHTML, /dsh-cost-meter/)
})

test('客户端：升级预警项「预防性处理」后，动作键立刻可用（不被视图状态藏住）', async () => {
  const dom = makeDom()
  const status = {
    ...STATUS,
    problems: [],
    summary: { blocked: 0, warned: 1, problems: 0 },
    upcoming: [
      { name: 'dshmarket', version: '1.66.6', level: 'fragile', levelText: '下一个小版本升级就会不兼容', breaksAt: '0.3.0', reason: 'dsh 升到 0.3.0 时该范围就不再满足' },
    ],
  }
  const exports = await loadClient({ dom, fetchImpl: fakeFetch({ status }) })
  exports.apply()
  await flush()

  const banner = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.match(banner.className, /dpd-warn/, '只有预警时用黄色')
  assert.match(banner.innerHTML, /预防性处理/)

  dom.document.fire('click', { target: clickTarget('data-dpd-pre', '0'), preventDefault() {}, stopPropagation() {} })
  const promoted = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.match(promoted.innerHTML, /dshmarket/, '提升后要看得见它')
  assert.match(promoted.innerHTML, /升级风险/)
  assert.equal(exports.__test.state.bindings['1'], 'quarantine', '提升后数字键必须真的绑上了')
})

test('客户端：没有问题时不出横幅，绝不干扰页面', async () => {
  const dom = makeDom()
  const empty = { ...STATUS, problems: [], upcoming: [], summary: {} }
  const exports = await loadClient({ dom, fetchImpl: fakeFetch({ status: empty }) })
  exports.apply()
  await flush()
  assert.equal(dom.document.getElementById('dsh-compat-doctor-banner'), null)
  assert.equal(dom.document.body.children.length, 0)
})

test('客户端：按 1 就发出隔离请求（这是「立刻修复」那条路）', async () => {
  const dom = makeDom()
  const impl = fakeFetch()
  const exports = await loadClient({ dom, fetchImpl: impl })
  exports.apply()
  await flush()

  const event = keyEvent('1')
  exports.__test.onKeyDown(event)
  assert.equal(event.prevented, true, '按键要被拦下，不能漏进页面')
  await flush()
  await flush()
  await flush()

  const post = impl.calls.find((c) => c.method === 'POST')
  assert.ok(post, '必须发出修复请求')
  assert.equal(post.url, '/dsh-compat-doctor/api/v1/repair')
  assert.deepEqual(JSON.parse(post.body), { action: 'quarantine', name: 'dsh-cost-meter' })

  const banner = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.match(banner.innerHTML, /已处理/, '结果要直接显示在横幅上（用户选的护栏）')
  assert.match(banner.innerHTML, /不需要重启|已处理/)
  assert.match(banner.innerHTML, /已备份 profile 配置/, '执行步骤也要显示出来')
})

test('客户端：正在输入框里打字时，裸数字键绝不被抢走；Alt+数字仍然有效', async () => {
  const dom = makeDom()
  const impl = fakeFetch()
  const exports = await loadClient({ dom, fetchImpl: impl })
  exports.apply()
  await flush()

  // 焦点在输入框：裸按 1 必须原样放过
  const textarea = new FakeElement('textarea')
  dom.document.activeElement = textarea
  const plain = keyEvent('1')
  exports.__test.onKeyDown(plain)
  assert.equal(plain.prevented, false, '在输入框里按 1 必须不被拦下 —— 否则用户打不了数字')
  await flush()
  assert.equal(impl.calls.filter((c) => c.method === 'POST').length, 0)

  // Alt+1 是明确的快捷键意图
  const withAlt = keyEvent('1', { alt: true })
  exports.__test.onKeyDown(withAlt)
  assert.equal(withAlt.prevented, true)
  await flush()
  await flush()
  await flush()
  assert.equal(impl.calls.filter((c) => c.method === 'POST').length, 1, 'Alt+数字要能穿透输入状态')
})

test('客户端：快捷键不吞 Ctrl/Cmd 组合键，也不吞没有绑定的数字', async () => {
  const dom = makeDom()
  const impl = fakeFetch()
  const exports = await loadClient({ dom, fetchImpl: impl })
  exports.apply()
  await flush()

  const ctrl = keyEvent('1')
  ctrl.ctrlKey = true
  exports.__test.onKeyDown(ctrl)
  assert.equal(ctrl.prevented, false)

  const unbound = keyEvent('7')
  exports.__test.onKeyDown(unbound)
  assert.equal(unbound.prevented, false)
  await flush()
  assert.equal(impl.calls.filter((c) => c.method === 'POST').length, 0)
})

test('客户端：Esc 收起后，同一个问题不再反复弹；问题集合变了要重新弹出', async () => {
  const dom = makeDom()
  const impl = fakeFetch()
  const exports = await loadClient({ dom, fetchImpl: impl })
  exports.apply()
  await flush()
  assert.ok(dom.document.getElementById('dsh-compat-doctor-banner'))

  exports.__test.onKeyDown(keyEvent('Escape'))
  assert.equal(dom.document.getElementById('dsh-compat-doctor-banner'), null, 'Esc 应当收起')
  assert.ok(dom.window.localStorage.getItem('dsh-compat-doctor:dismissed'), '收起要记住，否则会一直打扰')

  // 同样的问题再来一次：不弹
  await exports.__test.refresh(false)
  assert.equal(dom.document.getElementById('dsh-compat-doctor-banner'), null, '同一个问题收起后不该再弹')

  // 问题变了（比如又多了一个插件冲突）：必须重新弹出来
  impl.calls.length = 0
  const changed = {
    ...STATUS,
    problems: [...STATUS.problems, { name: 'another-plugin', version: '9.9.9', severity: 'block', inBundles: true, title: 'x', detail: '', actions: ['quarantine'], defaultAction: 'quarantine' }],
  }
  const dom2 = makeDom()
  const impl2 = fakeFetch({ status: changed })
  const exports2 = await loadClient({ dom: dom2, fetchImpl: impl2 })
  exports2.apply()
  await flush()
  assert.ok(dom2.document.getElementById('dsh-compat-doctor-banner'), '问题集合变了要重新提醒')
})

test('客户端：接口拿不到数据时安静退场，不报错、不残留 DOM', async () => {
  const dom = makeDom()
  const failing = () => Promise.reject(new Error('ECONNREFUSED'))
  failing.calls = []
  const exports = await loadClient({ dom, fetchImpl: failing })
  exports.apply()
  await flush()
  assert.equal(dom.document.getElementById('dsh-compat-doctor-banner'), null)
  assert.equal(exports.__test.state.status, null)
})

test('客户端：只有升级预警时用黄色提示，并给出「预防性处理」入口', async () => {
  const dom = makeDom()
  const status = {
    ...STATUS,
    problems: [],
    upcoming: [{ name: 'risky-plugin', version: '2.0.0', level: 'fragile', levelText: '下一个小版本升级就会不兼容', breaksAt: '0.3.0', reason: 'dsh 升到 0.3.0 时该范围就不再满足' }],
  }
  const exports = await loadClient({ dom, fetchImpl: fakeFetch({ status }) })
  exports.apply()
  await flush()
  const banner = dom.document.getElementById('dsh-compat-doctor-banner')
  assert.ok(banner)
  assert.equal(banner.className, 'dpd-warn')
  assert.match(banner.innerHTML, /升级预警/)
  assert.match(banner.innerHTML, /risky-plugin/)
  assert.match(banner.innerHTML, /2\.0\.0/)
  assert.match(banner.innerHTML, /0\.3\.0/)
  assert.match(banner.innerHTML, /预防性处理/)
})

test('客户端：模块形态正确 —— inject 为空、有 apply 与 unmount，且不 import 任何 dsh 包', async () => {
  const dom = makeDom()
  const exports = await loadClient({ dom, fetchImpl: fakeFetch() })
  assert.deepEqual(exports.inject, [], '不注入客户端服务，保持零依赖')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.unmount, 'function')

  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  assert.ok(!/^\s*import\s/m.test(source), '客户端产物必须是手写的、没有 import')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(!/@deepseek-ai\//.test(source.replace(/^\s*\/\/.*$/gm, '')), '不能引用任何 dsh 客户端包名')
})

test('客户端：unmount 之后不再监听键盘、也不留横幅', async () => {
  const dom = makeDom()
  const impl = fakeFetch()
  const exports = await loadClient({ dom, fetchImpl: impl })
  exports.apply()
  await flush()
  assert.ok(dom.document.listenerCount('keydown') > 0)
  assert.ok(dom.document.getElementById('dsh-compat-doctor-banner'))

  exports.unmount()
  assert.equal(dom.document.listenerCount('keydown'), 0)
  assert.equal(dom.document.listenerCount('click'), 0)
  assert.equal(dom.document.getElementById('dsh-compat-doctor-banner'), null)
})
