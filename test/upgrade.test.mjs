/**
 * 「快要不适配」前瞻分析的单元测试。
 *
 * 这里的断言刻意**用真实插件的真实声明范围**做样本（dsh-cost-meter / @linxin666/dsh-perf
 * 的声明是实测抄下来的），因为这一栏的结论会直接被页面横幅显示给用户，
 * 说错了比不说更糟。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RISK_LEVEL,
  assessRange,
  assessUpgradeRisk,
  isPatchOnlyRange,
  isPinnedRange,
  needsUpgradeWarning,
  nextMajor,
  nextMinor,
} from '../lib/upgrade.js'

// 实测抄下来的真实声明
const COST_METER_RANGE = '^0.1.0-rc.6 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.3-0 || ^0.1.5-0'
const PERF_RANGE = '>=0.1.2-rc.1'

test('nextMinor / nextMajor：预发布与补丁位都归零', () => {
  assert.equal(nextMinor('0.2.0-rc.2'), '0.3.0')
  assert.equal(nextMinor('0.1.7-rc.1'), '0.2.0')
  assert.equal(nextMinor('1.4.2'), '1.5.0')
  assert.equal(nextMajor('0.2.0-rc.2'), '1.0.0')
  assert.equal(nextMajor('1.4.2'), '2.0.0')
  assert.equal(nextMinor('不是版本'), undefined)
  assert.equal(nextMajor(''), undefined)
})

test('isPinnedRange / isPatchOnlyRange：识别最脆的两种写法', () => {
  assert.equal(isPinnedRange('0.1.7-rc.1'), true)
  assert.equal(isPinnedRange('=0.1.7'), true)
  assert.equal(isPinnedRange('^0.1.7'), false)
  assert.equal(isPinnedRange('>=0.1.2-rc.1'), false)
  assert.equal(isPinnedRange('*'), false)
  assert.equal(isPinnedRange('~0.1.7'), false)

  assert.equal(isPatchOnlyRange('~0.2.0-rc.1'), true)
  assert.equal(isPatchOnlyRange('~0.2.0 || ~0.3.0'), true)
  assert.equal(isPatchOnlyRange('^0.2.0 || ~0.3.0'), false)
})

test('已经不适配的范围判为 broken，不重复当预警报', () => {
  // 真实场景：本机 dsh 0.2.0-rc.2，cost-meter 的范围上限是 <0.2.0-0
  const r = assessRange(COST_METER_RANGE, '0.2.0-rc.2')
  assert.equal(r.level, RISK_LEVEL.BROKEN)
  assert.equal(needsUpgradeWarning(r), false, '已坏的由 declared-range 报，这里不该再报一次')
})

test('真实预测：同一个插件在 0.1.5 上还活着，但升到 0.2.0 就会死', () => {
  // 这条是「快要不适配」的核心价值：插件现在能用，但下一个 dsh 版本就会失配
  const r = assessRange(COST_METER_RANGE, '0.1.5-rc.3')
  assert.equal(r.level, RISK_LEVEL.FRAGILE)
  assert.equal(r.breaksAt, '0.2.0')
  assert.match(r.reason, /0\.2\.0/)
  assert.equal(needsUpgradeWarning(r), true)
})

test('开放上限的范围判为 safe —— 升级 dsh 不用管它', () => {
  const r = assessRange(PERF_RANGE, '0.2.0-rc.2')
  assert.equal(r.level, RISK_LEVEL.SAFE)
  assert.equal(needsUpgradeWarning(r), false)
})

test('钉死版本 → fragile；只收补丁号 → fragile', () => {
  const pinned = assessRange('0.2.0-rc.2', '0.2.0-rc.2')
  assert.equal(pinned.level, RISK_LEVEL.FRAGILE)
  assert.match(pinned.reason, /钉死/)

  const patch = assessRange('~0.2.0-rc.1', '0.2.0-rc.2')
  assert.equal(patch.level, RISK_LEVEL.FRAGILE)
  assert.match(patch.reason, /补丁号/)
})

test('caret 锁小版本也算「下一个版本会坏」—— 这正是野生插件最常见的情况', () => {
  // ^0.2.0-rc.1 在 npm 语义下是 >=0.2.0-rc.1 <0.3.0-0，所以 dsh 0.3.0 会踩雷
  const r = assessRange('^0.2.0-rc.1', '0.2.0-rc.2')
  assert.equal(r.level, RISK_LEVEL.FRAGILE)
  assert.equal(r.breaksAt, '0.3.0')
})

test('通配与全开放范围判为 safe', () => {
  assert.equal(assessRange('*', '0.2.0-rc.2').level, RISK_LEVEL.SAFE)
  assert.equal(assessRange('>=0.0.0', '0.2.0-rc.2').level, RISK_LEVEL.SAFE)
})

test('非法范围 / 缺参数 → unknown，不猜', () => {
  assert.equal(assessRange('这不是范围', '0.2.0-rc.2').level, RISK_LEVEL.UNKNOWN)
  assert.equal(assessRange('^0.1.0', undefined).level, RISK_LEVEL.UNKNOWN)
  assert.equal(assessRange('', '0.2.0-rc.2').level, RISK_LEVEL.UNKNOWN)
})

test('汇总取最严重的那条 —— 兼容性上最弱的约束才是真约束', () => {
  const a = assessUpgradeRisk({
    peers: [{ name: '@deepseek-ai/dsh', range: PERF_RANGE }],          // safe
    declared: [{ source: 'dsh.engines.dsh', range: '~0.2.0-rc.1' }],  // fragile
  }, '0.2.0-rc.2')
  assert.equal(a.level, RISK_LEVEL.FRAGILE)
  assert.equal(a.worst.where, 'dsh.engines.dsh')
  assert.equal(a.items.length, 2)

  const none = assessUpgradeRisk({}, '0.2.0-rc.2')
  assert.equal(none.level, RISK_LEVEL.UNKNOWN)
  assert.equal(none.items.length, 0)
  assert.equal(needsUpgradeWarning(none), false)
})
