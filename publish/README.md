# 上架到插件市场（awesome-dsh-plugin）

市场（`dshmarket` / dshmarket.com）里的清单来自精选列表
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
**收录 = 往那个仓库提一个 PR，只加一个文件**：

```
data/plugins/liujianqiao701__dsh-compat-vet.yml
```

本目录里的 `liujianqiao701__dsh-compat-vet.yml` 就是这个文件的内容，直接复制过去即可。

## 提交前的硬性条件（来自对方 contributing.md，逐条核对过）

| 条件 | 本插件现状 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`（只有 `dsh.client` 会被拒） | ✅ `dsh.bundle.patch = ./cordis.patch.yml` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 仓库有真实可用的代码 | ✅ 13 个 lib 模块 + 134 个单测 + 3 个真机验证脚本 |
| **仓库创建满 1 天** | ⏳ 由 CI 自动检查 —— 今天建仓库、明天再提 PR |
| 仓库加 `dsh-plugin` topic | ⏳ 建仓库后在 GitHub 上点一下 |
| 描述不含营销词、且与代码相符 | ✅ 见 yml；每条声明都对应真代码（隔离/卸载/备份/回滚/页面预警） |
| 条目里**不能**手写 `npm:` 字段 | ✅ 没写；npm 映射由 registry 自动采集 |

## npm 与收录的先后顺序（有个坑）

npm 映射是自动采集的，**条件是已发布包的 `repository` 字段指回被收录的那个仓库**
（`package.json` 里已填 `https://github.com/liujianqiao701/dsh-compat-vet`）。

⚠️ **映射一旦建立，市场的一键安装会走 npm**（`dsh plugin --profile web add dsh-compat-vet`）。
而 `--tag beta` 发布出来的包**没有 `latest`**，那样用户点一键安装会失败。

所以顺序必须是：

1. 今天：发 beta（占住包名，跑通发布链路）；
2. 建仓库、推代码（≥1 天）；
3. **把 0.3.0 提升为 latest**：`npm dist-tag add dsh-compat-vet@0.3.0 latest`；
4. 再提 PR。

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

## 分类为什么选 dev

同一个分类下已经有 3 个叫 `dsh-plugin-doctor` 的插件（PerryLink / zoahdev / white-sand-grand），
做的都是"插件体检"这类事。选 `dev` 与它们一致；差异靠描述说清楚：
本插件独有的是**页面内按键一键修复**（隔离/卸载，改前自动备份、失败自动回滚）
与**下一个 dsh 版本才会失效的提前预警**。

> 重复收录的风险如实说明：规则是"两个插件做同一件事时看谁更好，先来者只是平局时的排序依据"。
> 如果维护者认为与已有 3 个重复，被打回是可能的 —— 那时可以强调"一键修复 + 回滚"这部分是它们没有的。
