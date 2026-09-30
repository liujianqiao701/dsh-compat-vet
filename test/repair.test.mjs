/**
 * 修复层的测试。
 *
 * 重点不在「顺利时能修好」，而在**不顺利时会怎样**：
 * 备份能不能还原、复检不过会不会回滚、dsh 的拒绝码会不会被原样吞掉。
 * 这些路径在真机上很难复现，只能靠假服务把它们逼出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ACTION_TEXT,
  GUARANTEED_ACTIONS,
  REPAIR_ACTION,
  backupProfile,
  dshVerdictsOf,
  explainApplication,
  explainErrorCode,
  isGuaranteed,
  quarantineViaManifest,
  repairPlugin,
  repairViaManager,
  restoreBackup,
  runDshPlugin,
  withoutBundle,
} from '../lib/repair.js'

function mkProfile(bundles = ['a', 'b'], extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpd-repair-'))
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'profile-web',
    dependencies: { a: '^1.0.0', b: '^1.0.0' },
    dsh: { profile: { bundles } },
    ...extra,
  }, undefined, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

/** 假 pluginManager：记录调用，按脚本返回结果。 */
function fakeManager({ bundles = [], onCall } = {}) {
  const calls = []
  const record = (name, args) => {
    calls.push([name, ...args])
    if (onCall) return onCall(name, args)
    return undefined
  }
  return {
    calls,
    async setBundleEnabled(name, enabled) {
      const forced = record('setBundleEnabled', [name, enabled])
      return forced ?? { changed: true, stage: 'enable', target: name, enabled, application: 'applied' }
    },
    async removeBundle(name) {
      const forced = record('removeBundle', [name])
      return forced ?? { changed: true, stage: 'remove', target: name, application: 'applied' }
    },
    async installBundle(spec) {
      const forced = record('installBundle', [spec])
      return forced ?? { changed: true, stage: 'install', target: spec, application: 'restart-required' }
    },
    async listBundles() {
      record('listBundles', [])
      return bundles
    },
  }
}

test('withoutBundle：只摘名字，别的字段一个不动', () => {
  const manifest = { name: 'x', dependencies: { a: '1' }, dsh: { profile: { bundles: ['a', 'b'] }, engines: { dsh: '*' } } }
  const { manifest: next, removed } = withoutBundle(manifest, 'a')
  assert.equal(removed, true)
  assert.deepEqual(next.dsh.profile.bundles, ['b'])
  assert.deepEqual(next.dependencies, { a: '1' }, '依赖必须保留 —— 隔离不等于卸载')
  assert.deepEqual(next.dsh.engines, { dsh: '*' }, '同一层其它字段不能被吃掉')
  assert.deepEqual(manifest.dsh.profile.bundles, ['a', 'b'], '不能就地改原对象')

  const miss = withoutBundle(manifest, 'zzz')
  assert.equal(miss.removed, false)
  assert.equal(miss.manifest, manifest)

  assert.equal(withoutBundle({}, 'a').removed, false)
  assert.equal(withoutBundle({ dsh: {} }, 'a').removed, false)
})

test('备份 / 还原：原样回来', () => {
  const dir = mkProfile()
  const original = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
  const backup = backupProfile(dir)
  assert.deepEqual(backup.files.sort(), ['cordis.patch.yml', 'package.json'])

  fs.writeFileSync(path.join(dir, 'package.json'), '{"broken":true}\n')
  const restored = restoreBackup(backup, dir)
  assert.deepEqual(restored.sort(), ['cordis.patch.yml', 'package.json'])
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), original)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('兜底隔离：直接改清单也能摘掉 bundles，且写的是 2 空格 + 结尾换行', () => {
  const dir = mkProfile(['a', 'b'])
  const result = quarantineViaManifest(dir, 'a')
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  const text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
  assert.match(text, /\n$/, '必须保留结尾换行 —— 与 dsh 自己写清单的格式一致')
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed.dsh.profile.bundles, ['b'])
  assert.deepEqual(parsed.dependencies, { a: '^1.0.0', b: '^1.0.0' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('dsh 的拒绝码都有人话解释，未知码不装懂', () => {
  for (const code of ['management-required', 'not-removable', 'stop-profile', 'bundle-in-use', 'incompatible-version']) {
    const text = explainErrorCode(code)
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 6, `${code} 必须有可读解释`)
  }
  assert.match(explainErrorCode('management-required'), /受保护/)
  assert.match(explainErrorCode('not-removable'), /隔离/)
  assert.match(explainErrorCode('没见过的码'), /没见过的码/)
  assert.equal(explainErrorCode(undefined), undefined)
})

test('application 字段翻译：applied 才是「不用重启」', () => {
  assert.match(explainApplication('applied'), /不需要重启/)
  assert.match(explainApplication('restart-required'), /需要重启/)
  assert.equal(explainApplication(undefined), undefined)
})

test('repairViaManager：三个动作打到对的官方方法上', async () => {
  const manager = fakeManager()
  await repairViaManager(manager, REPAIR_ACTION.QUARANTINE, { name: 'dsh-cost-meter' })
  assert.deepEqual(manager.calls[0], ['setBundleEnabled', 'dsh-cost-meter', false])

  await repairViaManager(manager, REPAIR_ACTION.UNINSTALL, { name: 'x' })
  assert.deepEqual(manager.calls[1], ['removeBundle', 'x'])

  await repairViaManager(manager, REPAIR_ACTION.UPGRADE, { name: 'x' })
  assert.deepEqual(manager.calls[2], ['installBundle', 'x@latest'])
})

test('repairViaManager：错误码与抛异常都被收成一句人话', async () => {
  const returned = fakeManager({
    onCall: () => ({ changed: false, application: 'failed', error: { code: 'not-removable' } }),
  })
  const a = await repairViaManager(returned, REPAIR_ACTION.UNINSTALL, { name: 'x' })
  assert.equal(a.ok, false)
  assert.equal(a.code, 'not-removable')

  const thrown = fakeManager({ onCall: () => { throw Object.assign(new Error('boom'), { code: 'stop-profile' }) } })
  const b = await repairViaManager(thrown, REPAIR_ACTION.QUARANTINE, { name: 'x' })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'stop-profile')
  assert.match(b.text, /停掉/)
})

test('dshVerdictsOf：把 dsh 自己的判定抽出来，没有的就不报', async () => {
  const manager = fakeManager({
    bundles: [
      { name: 'ok-plugin', enabled: true },
      { name: 'dsh-cost-meter', enabled: true, error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-cost-meter', version: '1.7.35', runtimeVersion: '0.2.0-rc.2', peers: { '@deepseek-ai/dsh': '^0.1.0' } }] } },
    ],
  })
  const verdicts = await dshVerdictsOf(manager)
  assert.equal(verdicts.available, true)
  assert.equal(verdicts.items.length, 1)
  assert.equal(verdicts.items[0].name, 'dsh-cost-meter')
  assert.equal(verdicts.items[0].version, '1.7.35')
  assert.equal(verdicts.items[0].runtimeVersion, '0.2.0-rc.2')

  const none = await dshVerdictsOf(undefined)
  assert.equal(none.available, false)
  assert.equal(none.items.length, 0)
})

test('repairPlugin 隔离：走官方服务、备份留存、dsh 复查确认清干净', async () => {
  const dir = mkProfile(['dsh-cost-meter', 'other'])
  // 假服务必须**真的把清单改掉** —— 「改动已落盘」现在正是判定修复成功的第一依据
  const manager = fakeManager({
    bundles: [],
    onCall: (name, args) => {
      if (name !== 'setBundleEnabled') return undefined
      const file = path.join(dir, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((one) => one !== args[0])
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
      return { changed: true, stage: 'enable', target: args[0], enabled: args[1], application: 'applied' }
    },
  })
  const steps = []
  const result = await repairPlugin({
    action: REPAIR_ACTION.QUARANTINE,
    target: { name: 'dsh-cost-meter', version: '1.7.35' },
    profileDir: dir,
    profileName: 'web',
    installAnchor: '/nope/@deepseek-ai/dsh/package.json',
    manager,
    onStep: (label) => steps.push(label),
    reaudit: async () => ({ items: [], summary: { blocked: 0 } }),
  })
  assert.equal(result.ok, true, JSON.stringify(result, undefined, 2))
  assert.deepEqual(manager.calls[0], ['setBundleEnabled', 'dsh-cost-meter', false], '必须走官方服务，不自己写文件')
  assert.equal(result.usedDshService, true)
  assert.equal(result.persisted, true, '改动必须真的落盘')
  assert.equal(result.clearedByDsh, true)
  assert.equal(result.clearedByMe, true)
  assert.equal(result.verified, true)
  assert.equal(result.guaranteed, true)
  assert.ok(fs.existsSync(result.backupDir), '备份目录应当留着')
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), undefined, 2) + '\n')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairPlugin：真机情形 —— 已落盘、复检干净，但 dsh 本进程还没重估 → **必须判成功**', async () => {
  // 这是真机验证抓出来的那个 bug 的回归测试。
  // 实测 `setBundleEnabled` 返回 application='restart-required'，紧接着问 listBundles()
  // 拿到的还是**旧结论**。采样一次就下结论 → 会把一次**正确的修复**判失败并回滚。
  // 正确语义：判定只看「真的落盘了」+「我的复检干净了」；
  // dsh 在本进程里的即时结论只作为信息如实上报，不能拿它判失败。
  const dir = mkProfile(['dsh-cost-meter', 'other'])
  const manager = fakeManager({
    bundles: [{
      name: 'dsh-cost-meter',
      error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-cost-meter', version: '1.7.35', runtimeVersion: '0.2.0-rc.2' }] },
    }],
    onCall: (name, args) => {
      if (name !== 'setBundleEnabled') return undefined
      const file = path.join(dir, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((one) => one !== args[0])
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
      return { changed: true, stage: 'enable', target: args[0], enabled: args[1], application: 'restart-required' }
    },
  })
  const result = await repairPlugin({
    action: REPAIR_ACTION.QUARANTINE,
    target: { name: 'dsh-cost-meter' },
    profileDir: dir,
    profileName: 'web',
    installAnchor: '/nope/@deepseek-ai/dsh/package.json',
    manager,
    reaudit: async () => ({ items: [], summary: { blocked: 0 } }),
  })
  assert.equal(result.ok, true, JSON.stringify(result, undefined, 2))
  assert.equal(result.verified, true, '落盘 + 复检干净 = 修好了')
  assert.equal(result.persisted, true)
  assert.equal(result.clearedByDsh, false, 'dsh 本进程的旧结论要如实上报，但不能拿它判失败')
  assert.equal(result.application, 'restart-required')
  assert.match(result.applicationText, /重启/)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['other'], '改动必须留着，绝不能被回滚')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairPlugin：我的复检仍报问题 → 回滚 + 如实报失败', async () => {
  const dir = mkProfile(['a', 'b'])
  const manager = fakeManager({
    bundles: [],
    onCall: (name, args) => {
      if (name !== 'setBundleEnabled') return undefined
      const file = path.join(dir, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((one) => one !== args[0])
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
      return { changed: true, stage: 'enable', target: args[0], enabled: args[1], application: 'applied' }
    },
  })
  const result = await repairPlugin({
    action: REPAIR_ACTION.QUARANTINE,
    target: { name: 'a' },
    profileDir: dir,
    profileName: 'web',
    installAnchor: '/nope/@deepseek-ai/dsh/package.json',
    manager,
    reaudit: async () => ({ items: [{ name: 'a', severity: 'block', title: '还是不兼容' }], summary: {} }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  assert.equal(result.verified, false)
  assert.match(result.error, /复检没过/)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['a', 'b'], '必须还原成改动前的样子')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairPlugin：服务说改了但**根本没落盘** → 回滚 + 如实报失败', async () => {
  const dir = mkProfile(['a', 'b'])
  const manager = fakeManager({ bundles: [] }) // 假服务只报成功，不动文件
  const result = await repairPlugin({
    action: REPAIR_ACTION.QUARANTINE,
    target: { name: 'a' },
    profileDir: dir,
    profileName: 'web',
    installAnchor: '/nope/@deepseek-ai/dsh/package.json',
    manager,
    reaudit: async () => ({ items: [], summary: {} }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.persisted, false)
  assert.equal(result.rolledBack, true)
  assert.match(result.error, /没有落盘/)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['a', 'b'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairPlugin：官方服务拒绝 → 回滚，并把 dsh 的拒绝码带回来', async () => {
  const dir = mkProfile()
  const manager = fakeManager({
    onCall: () => ({ changed: false, application: 'failed', error: { code: 'management-required' } }),
  })
  const result = await repairPlugin({
    action: REPAIR_ACTION.UNINSTALL,
    target: { name: 'a' },
    profileDir: dir,
    profileName: 'web',
    installAnchor: '/nope/@deepseek-ai/dsh/package.json',
    manager,
    reaudit: async () => ({ items: [], summary: {} }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'management-required')
  assert.equal(result.rolledBack, true)
  assert.match(result.error, /受保护/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairPlugin：没有 pluginManager 时，隔离仍能靠直接改清单完成（并说明这一点）', async () => {
  const dir = mkProfile(['a', 'b'])
  const result = await repairPlugin({
    action: REPAIR_ACTION.QUARANTINE,
    target: { name: 'a' },
    profileDir: dir,
    profileName: 'web',
    installAnchor: '/nope/@deepseek-ai/dsh/package.json',
    manager: undefined,
    reaudit: async () => ({ items: [], summary: {} }),
  })
  assert.equal(result.ok, true, JSON.stringify(result, undefined, 2))
  assert.equal(result.usedDshService, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dsh.profile.bundles, ['b'])
  assert.ok(result.steps.some((s) => /没有 pluginManager|直接改写/.test(s.label)), '必须如实告知走了兜底路径')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairPlugin：升级不属于「保证消除冲突」，不满足也必须如实报告', async () => {
  const dir = mkProfile()
  const manager = fakeManager({ bundles: [{ name: 'a', error: { code: 'incompatible-version', incompatible: [{ name: 'a', version: '2.0.0', runtimeVersion: '0.2.0-rc.2' }] } }] })
  const result = await repairPlugin({
    action: REPAIR_ACTION.UPGRADE,
    target: { name: 'a' },
    profileDir: dir,
    profileName: 'web',
    installAnchor: '/nope/@deepseek-ai/dsh/package.json',
    manager,
    reaudit: async () => ({ items: [], summary: {} }),
  })
  assert.equal(result.ok, true, '升级执行成功就是成功，哪怕装完还是不兼容')
  assert.equal(result.guaranteed, false)
  assert.equal(result.clearedByDsh, false)
  assert.equal(result.verified, true, '非保证类动作不要求复查干净')
  assert.equal(result.rolledBack, undefined, '不该因为「装了但还不兼容」就回滚')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairPlugin：动作/目标非法时立刻拒绝，不碰 profile', async () => {
  const dir = mkProfile()
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
  const bad = await repairPlugin({ action: 'rm-rf', target: { name: 'a' }, profileDir: dir })
  assert.equal(bad.ok, false)
  const noName = await repairPlugin({ action: REPAIR_ACTION.QUARANTINE, target: {}, profileDir: dir })
  assert.equal(noName.ok, false)
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before)
  assert.equal(fs.readdirSync(dir).some((f) => f === '.compat-vet-backup'), false, '非法请求不该留下备份目录')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('保证类动作的名单是固定的：升级不在里面', () => {
  assert.deepEqual(GUARANTEED_ACTIONS, [REPAIR_ACTION.QUARANTINE, REPAIR_ACTION.UNINSTALL])
  assert.equal(isGuaranteed(REPAIR_ACTION.UPGRADE), false)
  assert.equal(isGuaranteed(REPAIR_ACTION.QUARANTINE), true)
  // 三条动作都必须有中文说明，页面上要显示
  for (const action of Object.values(REPAIR_ACTION)) assert.ok(ACTION_TEXT[action].length > 4)
})

test('runDshPlugin：找不到 dsh 命令行入口时明确报错，不起进程', async () => {
  const result = await runDshPlugin(
    { installAnchor: path.join(os.tmpdir(), 'definitely-not-here', '@deepseek-ai', 'dsh', 'package.json'), profileName: 'web' },
    ['remove', 'x'],
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-cli')
  assert.match(result.text, /找不到 dsh 的命令行入口/)
})
