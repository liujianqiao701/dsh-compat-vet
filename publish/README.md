# 上架到插件市场（awesome-dsh-plugin）

市场（`dshmarket` / dshmarket.com）里的清单来自精选列表
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
**收录 = 往那个仓库提一个 PR，只加一个文件**：

```
data/plugins/liujianqiao701__dsh-compat-vet.yml
```

本目录里的 `liujianqiao701__dsh-compat-vet.yml` 就是这个文件的内容，直接复制过去即可。

## 当前进度

| 事项 | 状态 |
| --- | --- |
| npm 发布 | ✅ [`dsh-compat-vet@0.3.0`](https://www.npmjs.com/package/dsh-compat-vet)（`latest`），已用「空白 profile 装 → 真启动 → 取横幅 → 卸载」16 项验证 |
| GitHub 仓库 | ✅ [liujianqiao701/dsh-compat-vet](https://github.com/liujianqiao701/dsh-compat-vet)（public），`main` 已推送 |
| `dsh-plugin` 主题标签 | ✅ 已设（另加 `deepseek-harness`/`dsh`/`cordis`/`plugin-compatibility`） |
| 仓库年龄 ≥ 1 天 | ⏳ 2026-09-30 建的 → 最早 **2026-10-01** 才能提 PR |
| 提 PR | ⏳ 待你执行（命令见下） |

## 提交前的硬性条件（来自对方 contributing.md，逐条核对过）

| 条件 | 本插件现状 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`（只有 `dsh.client` 会被拒） | ✅ `dsh.bundle.patch = ./cordis.patch.yml`（已从远程仓库复核） |
| 仓库根有 `cordis.patch.yml` | ✅ （远程 HTTP 200） |
| 仓库有真实可用的代码 | ✅ 11 个 lib 模块 + 134 个单测 + 4 个真机/打包验证脚本 |
| **仓库创建满 1 天** | ⏳ 由 CI 自动检查 |
| 仓库加 `dsh-plugin` topic | ✅ 已设 |
| 描述不含营销词、且与代码相符 | ✅ 见 yml；每条声明都对应真代码（隔离/卸载/备份/回滚/页面预警） |
| 条目里**不能**手写 `npm:` 字段 | ✅ 没写；npm 映射由 registry 自动采集 |
| 一个 PR 最多 3 条 | ✅ 只有 1 条 |

## npm 映射是自动的（有前提）

npm 映射**不需要**在 yml 里写任何字段——由 registry 自动采集，
**条件是已发布包的 `repository` 字段指回被收录的那个仓库**：
`package.json` 里已填 `https://github.com/liujianqiao701/dsh-compat-vet` ✅

⚠️ **映射生效后，市场的一键安装会走 npm**（`dsh plugin --profile web add dsh-compat-vet`），
所以 `latest` 必须指向一个真实可装的版本 —— 当前 `latest = 0.3.0`，已实测可装 ✅

## 提 PR 的命令

你已经有 fork（`liujianqiao701/awesome-dsh-plugin`，2026-09-22 建的）：

```sh
git clone https://github.com/liujianqiao701/awesome-dsh-plugin.git
cd awesome-dsh-plugin
cp <本目录>/liujianqiao701__dsh-compat-vet.yml data/plugins/
git checkout -b add-dsh-compat-vet
git add data/plugins/liujianqiao701__dsh-compat-vet.yml
git commit -m "Add dsh-compat-vet"
git push -u origin add-dsh-compat-vet
```

然后打开 GitHub 提示的链接建 PR（目标仓库 `awesome-dsh-plugin/awesome-dsh-plugin`）。
**不要**手工编辑两个 README —— 它们由 `data/plugins/*.yml` 生成，合并后在 main 上自动重建。
CI 失败会在 PR 里指出要改什么，**在同一分支上推修复即可，不用重开 PR**。

## 分类为什么选 dev

同一个分类下已经有 3 个叫 `dsh-plugin-doctor` 的插件（PerryLink / zoahdev / white-sand-grand），
做的都是"插件体检"这类事。选 `dev` 与它们一致；差异靠描述说清楚：
本插件独有的是**页面内按键一键修复**（隔离/卸载，改前自动备份、失败自动回滚）
与**下一个 dsh 版本才会失效的提前预警**。

> 重复收录的风险如实说明：规则是"两个插件做同一件事时看谁更好，先来者只是平局时的排序依据"。
> 如果维护者认为与已有 3 个重复，被打回是可能的 —— 那时可以强调"一键修复 + 回滚"这部分是它们没有的。
