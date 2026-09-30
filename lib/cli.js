#!/usr/bin/env node
/**
 * dsh-compat-vet 命令行入口。
 *
 * 存在意义：宿主插件只在 dsh **成功启动之后**才跑得起来。
 * 而「插件与 dsh 版本不兼容」最坏的后果恰恰是 dsh 起不来 ——
 * 那时插件帮不上忙，只能靠这个独立 CLI。
 *
 * 用法：
 *   dsh-compat-vet                       # 检查默认 profile
 *   dsh-compat-vet --profile web         # 指定 profile
 *   dsh-compat-vet --json                # 输出结构化 JSON
 *   dsh-compat-vet --all                 # 连通过的插件也列出来
 *   dsh-compat-vet --quiet               # 只输出结论行（给脚本用）
 *
 * 退出码：0 = 没有阻断/警告；1 = 发现问题；2 = 体检未能完成。
 */
import fs from 'node:fs'
import process from 'node:process'
import { auditProfileProbed } from './audit.js'
import { renderReport } from './report.js'
import { resolveContext } from './adapt.js'

const HELP = `dsh-compat-vet —— DSH 插件兼容性体检

检查已安装插件的版本要求与当前 dsh 运行时是否冲突，并给出升级/卸载/豁免命令。
可在 dsh 起不来时使用（不依赖 dsh 自身的任何模块）。

它会探测本机 dsh 的版本与能力（含对 dsh 兼容性预检的**实测校准**），
据此调整判定、后果描述与可用命令 —— 所以不需要跟着 dsh 版本手动更新。

选项：
  --profile <名字>   profile 名，默认取 $DSH_PROFILE 或 web
  --home <目录>      DSH_HOME，默认取 $DSH_HOME 或 ~/.dsh
  --anchor <路径>    dsh 的 package.json 绝对路径（自动探测失败时手动指定）
  --dsh-version <v>  强制指定 dsh 版本（仅用于验证，正常不用传）
  --json             输出结构化 JSON
  --all              连没有问题的插件一起列出
  --quiet            只输出一行结论
  --help             显示本帮助

退出码：0 正常；1 发现兼容性问题；2 体检未完成。
`

/** 极简参数解析（不引任何依赖）。 */
function parseArgs(argv) {
  const out = { flags: new Set(), opts: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const takesValue = ['profile', 'home', 'anchor', 'dsh-version'].includes(key)
    if (takesValue) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out.opts[key] = next; i += 1 } else { out.opts[key] = '' }
    } else {
      out.flags.add(key)
    }
  }
  return out
}

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2))

  if (flags.has('help') || flags.has('h')) { process.stdout.write(HELP); return 0 }

  const targets = resolveContext({
    config: {
      profileName: opts.profile || undefined,
      profileDir: undefined,
      home: opts.home || undefined,
      installAnchor: opts.anchor || undefined,
    },
  })
  const { profileDir, profileName, installAnchor } = targets

  if (!profileDir || !fs.existsSync(profileDir)) {
    process.stderr.write(
      `dsh-compat-vet: 找不到 profile 目录 ${profileDir ?? '(未能推导)'}\n`
      + `  推导依据：profile 名 <- ${targets.sources.profileName}；目录 <- ${targets.sources.profileDir}\n`
      + '  用 --profile <名字> / --home <目录> 指定，或确认 dsh 是否装好了。\n',
    )
    return 2
  }

  const report = await auditProfileProbed({
    profileDir,
    profileName,
    installAnchor,
    runtimeVersion: opts['dsh-version'] || undefined,
  })

  if (report.error) {
    process.stderr.write(`dsh-compat-vet: 体检未能完成 —— ${report.error}\n`)
    return 2
  }

  if (!report.runtimeVersion) {
    process.stderr.write(
      'dsh-compat-vet: 警告：没能定位 dsh 安装目录，无法得知运行时版本，'
      + '本次只检查结构性缺陷（缺包、未启用、清单不可读）与 Node 版本。\n'
      + `  安装位置推导依据：${targets.sources.installAnchor}\n`
      + '  用 --anchor <dsh 的 package.json 路径> 显式指定可恢复完整检查。\n\n',
    )
  }

  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (flags.has('quiet')) {
    const s = report.summary
    process.stdout.write(
      `${s.problems === 0 && s.bundleIssues === 0 ? 'OK' : 'PROBLEMS'} `
      + `dsh=${report.runtimeVersion ?? '?'} profile=${profileName} `
      + `blocked=${s.blocked} warned=${s.warned} bundleIssues=${s.bundleIssues}\n`,
    )
  } else {
    process.stdout.write(`${renderReport(report, { includeOk: flags.has('all') })}\n`)
  }

  return (report.summary.problems > 0 || report.summary.bundleIssues > 0) ? 1 : 0
}

process.exitCode = await main()
