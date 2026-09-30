/**
 * semver 求值器单元测试。
 *
 * 关键用例是**与本机 dsh 自带的真 `semver` 对拍** ——
 * 本插件的判定必须与 dsh 自己的 `evaluatePluginCompatibility` 一致，
 * 否则会误报或漏报。取不到真 semver 时该组用例自动跳过（不算失败）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { satisfies, validRange, parseVersion, compareVersions } from '../lib/semver.js'
import { locateAnchor, nodeModulesOf } from '../lib/locate.js'

const RUNTIME = '0.2.0-rc.2'

test('parseVersion 解析各段与预发布/构建元数据', () => {
  assert.deepEqual(
    { ...parseVersion('1.2.3-rc.1+build.5'), parts: undefined, raw: undefined },
    { major: 1, minor: 2, patch: 3, pre: ['rc', '1'], build: ['build', '5'], parts: undefined, raw: undefined },
  )
  assert.equal(parseVersion('0.2.0').parts, 3)
  assert.equal(parseVersion('0.2').parts, 2)
  assert.equal(parseVersion('0').parts, 1)
  assert.equal(parseVersion('not-a-version'), null)
})

test('compareVersions 遵循 SemVer §11 优先级', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1) // 预发布 < 正式版
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1) // 数字标识符按数值比
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1) // 数字 < 字母数字
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1) // 前缀短的小
})

test('真实环境里的判定（这些结论必须与 dsh 一致）', () => {
  // dsh 自己启动时会拒绝 dsh-cost-meter@1.7.35 —— 复现这个结论
  assert.equal(satisfies(RUNTIME, '^0.1.0-rc.6 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.3-0 || ^0.1.5-0', { includePrerelease: true }), false)
  assert.equal(satisfies(RUNTIME, '^0.1.5-0', { includePrerelease: true }), false)
  // 被这个范围放行的插件
  assert.equal(satisfies(RUNTIME, '>=0.2.0-rc.1', { includePrerelease: true }), true)
  assert.equal(satisfies(RUNTIME, '>=0.0.1-rc <2', { includePrerelease: true }), true)
  assert.equal(satisfies(RUNTIME, '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1', { includePrerelease: true }), true)
  assert.equal(satisfies(RUNTIME, '>=0.1.2-rc.1', { includePrerelease: true }), true)
  // 预发布不满足正式版下界
  assert.equal(satisfies(RUNTIME, '^0.2.0', { includePrerelease: true }), false)
  assert.equal(satisfies(RUNTIME, '^0.2.0-rc.0', { includePrerelease: true }), true)
})

test('运算符、通配与连字符区间', () => {
  assert.equal(satisfies('1.2.3', '^1.2.0'), true)
  assert.equal(satisfies('1.9.9', '^1.2.0'), true)
  assert.equal(satisfies('2.0.0', '^1.2.0'), false)
  assert.equal(satisfies('0.2.5', '^0.2.0'), true)
  assert.equal(satisfies('0.3.0', '^0.2.0'), false)
  assert.equal(satisfies('0.0.3', '^0.0.3'), true)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
  assert.equal(satisfies('1.2.9', '~1.2.0'), true)
  assert.equal(satisfies('1.3.0', '~1.2.0'), false)
  assert.equal(satisfies('1.2.3', '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfies('2.0.0', '>=1.0.0 <2.0.0'), false)
  assert.equal(satisfies('1.2.3', '1.2.x'), true)
  assert.equal(satisfies('1.3.0', '1.2.x'), false)
  assert.equal(satisfies('1.5.0', '1'), true)
  assert.equal(satisfies('2.0.0', '1'), false)
  assert.equal(satisfies('1.2.3', '*'), true)
  assert.equal(satisfies('1.2.3', '1.2.3 - 2.3.4'), true)
  assert.equal(satisfies('2.3.4', '1.2.3 - 2.3.4'), true)
  assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false)
  assert.equal(satisfies('1.2.3', '>=1.2'), true)
  assert.equal(satisfies('1.1.9', '>=1.2'), false)
  assert.equal(satisfies('1.1.9', '<1.2'), true)
  assert.equal(satisfies('1.2.0', '<1.2'), false)
  // 以下几条是实测 npm 语义后的回归断言，反直觉但必须照做：
  // ① 部分版本运算符是「进位到下一段」，不是补零 —— >1.2 等于 >=1.3.0-0
  assert.equal(satisfies('1.2.3', '>1.2', { includePrerelease: true }), false)
  assert.equal(satisfies('1.3.0', '>1.2', { includePrerelease: true }), true)
  assert.equal(satisfies('1.2.9', '<=1.2', { includePrerelease: true }), true)
  assert.equal(satisfies('1.3.0', '<=1.2', { includePrerelease: true }), false)
  // ② 预发布版**小于**同号正式版，所以 <0.2.0 能容纳 0.2.0-rc.2
  assert.equal(satisfies('0.2.0-rc.2', '<0.2.0', { includePrerelease: true }), true)
  assert.equal(satisfies('0.2.0-rc.2', '^0.1.0', { includePrerelease: true }), false)
  // ③ 通配段的下界带 -0，因此能容纳边界上的预发布版
  assert.equal(satisfies('1.2.3-rc.1', '1.2.x', { includePrerelease: true }), true)
  // ④ 连字符区间的下界总带 -0，上界进位
  assert.equal(satisfies('1.2.3-rc.1', '1.2.3 - 2.3.4', { includePrerelease: true }), true)
  assert.equal(satisfies('1.2.2', '1.2.3 - 2.3.4', { includePrerelease: true }), false)
})

test('workspace: 协议交给 dsh 语义处理（恒真）', () => {
  assert.equal(satisfies(RUNTIME, 'workspace:^'), true)
  assert.equal(satisfies(RUNTIME, 'workspace:*'), true)
})

test('validRange 拒绝非法范围', () => {
  assert.equal(validRange('^1.2.3'), true)
  assert.equal(validRange('>=0.0.1-rc <2'), true)
  assert.equal(validRange('不是版本'), false)
})

test('与 dsh 自带的真 semver 对拍（取不到则跳过）', async (t) => {
  const anchor = locateAnchor()
  if (!anchor) return t.skip('未找到 dsh 安装目录，跳过对拍')
  const semverEntry = path.join(nodeModulesOf(anchor), 'semver', 'index.js')
  if (!fs.existsSync(semverEntry)) return t.skip(`未找到 ${semverEntry}，跳过对拍`)
  const real = await import(pathToFileURL(semverEntry).href)
  const semver = real.default ?? real

  const versions = [
    '0.2.0-rc.2', '0.2.0-rc.1', '0.2.0', '0.1.5-0', '1.2.3', '1.2.3-rc.1', '1.2.0-rc.1',
    '2.0.0', '0.0.3', '1.9.9', '0.0.0-0', '1.2.2', '1.3.0', '2.3.4', '2.3.5-rc.1', '0.2.5',
  ]
  const ranges = [
    '^0.1.0-rc.6 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.3-0 || ^0.1.5-0',
    '^0.1.5-0', '>=0.2.0-rc.1', '>=0.0.1-rc <2', '^0.2.0', '^0.2.0-rc.0',
    '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1',
    '>=0.1.2-rc.1', '~1.2.0', '^1.2.0', '>=1.0.0 <2.0.0', '1.2.x', '1', '*',
    '1.2.3 - 2.3.4', '>=1.2', '<1.2', '<=1.2', '>1.2', '1 - 2', '1.2 - 2.3',
    '^0', '^0.0', '~1', '~0.2', '1.x', '^1', '=1.2', '=1', '<0.2.0', '^0.1.0', '<=0.1.5',
    '>1.2.3', '<1.2.3', '<=1.2.3', '>=1.2.3', '1.2.3', '1.2.*', 'x', '~1.2.3', '^1.2',
  ]
  // dsh 只用 includePrerelease: true，但两种模式都对齐能证明求值器整体正确
  const optionSets = [{ includePrerelease: true }, { includePrerelease: false }]

  let compared = 0
  const mismatches = []
  for (const opts of optionSets) {
    for (const v of versions) {
      for (const r of ranges) {
        const mine = satisfies(v, r, opts)
        const theirs = semver.satisfies(v, r, opts)
        compared += 1
        if (mine !== theirs) {
          mismatches.push(`[includePrerelease=${opts.includePrerelease}] ${v} vs ${r}: 本实现=${mine} semver=${theirs}`)
        }
      }
    }
  }
  assert.equal(compared, versions.length * ranges.length * optionSets.length)
  assert.deepEqual(mismatches, [], `与真 semver 存在 ${mismatches.length} 处不一致`)

  // validRange 的合法性判定也要一致
  const rangeValidityMismatch = ranges.filter((r) => validRange(r) !== Boolean(semver.validRange(r)))
  assert.deepEqual(rangeValidityMismatch, [], 'validRange 判定与真 semver 不一致')

  console.log(`  ✓ 与真 semver 对拍 ${compared} 组 satisfies + ${ranges.length} 组 validRange，全部一致`)
})
