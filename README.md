# dsh-compat-doctor

**DSH 插件兼容性体检 + 页面上的一键修复** —— 检查已安装插件与当前 dsh 运行时是否冲突，
中文预警并给出**可直接执行**的命令；装了本插件之后，`dsh web` 的页面顶部会直接弹出横幅，
**照着按键就能当场修掉**（不提供「版本豁免」这个选项，理由见 §4④）。

**它跟着 dsh 版本自己变，不需要你为任何 dsh 版本改一行代码。**（见 §2）

---

## 1. 它解决什么问题

dsh 升级后，老插件常常因为 peer 依赖范围不匹配而被**启动预检拒绝加载**。此时的表现很有迷惑性：

- 插件还在 `dsh plugin list` 里、文件也还在 `node_modules` 里，**看起来没坏**；
- 但功能整块消失，或者 dsh 直接起不来；
- dsh 只会往 stderr 打一行**英文**告警，而且只在**恰好安装那一个插件时**才出现 ——
  等到某天重启 dsh 才发现问题，已经很难回溯。

本插件把这件事变成**主动、集中、中文、可操作**的体检 —— 而且在 `dsh web` 上
**直接变成页面顶部的一条横幅，按键就能当场修掉**（§4④）。

### 本机实测（这就是它的目标场景）

当前环境 dsh `0.2.0-rc.2`，profile `web`。dsh 自己的启动日志：

```
dsh: skipping profile bundle "dsh-cost-meter": Error: Plugin dsh-cost-meter@1.7.35 is
incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-credentials":
"^0.1.0-rc.6 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.3-0 || ^0.1.5-0", ...}
```

本插件对同一环境的结论（`dsh-compat-doctor` / `plugin_compat_check` 工具）：

```
[阻断] dsh-cost-meter @ 1.7.35
  [阻断] 与 dsh 0.2.0-rc.2 不兼容，启动时会被拒绝加载
         处理办法：
           dsh plugin --profile web add dsh-cost-meter@latest
           dsh plugin --profile web remove dsh-cost-meter
           dsh plugin --profile web allow-version dsh-cost-meter@1.7.35 \
             --dsh-version 0.2.0-rc.2 --accept-risk
```

两者结论一致；差别在于本插件是**集中报告 + 中文 + 带修复命令**。

---

## 2. 怎么做到「适配任意 dsh 版本」——实测，不是猜

### 2.1 先说不做什么：不写版本号 `if`

最省事、也最不靠谱的做法是维护一张表：

```js
// ❌ 本插件刻意不这么写
if (semver.gte(version, '0.1.7-rc.1') && semver.lt(version, '0.3.0')) { … }
```

这种代码**每个 dsh 新版本都要人来改一次** —— 正是要避免的事。而且它基于一个错误假设：
「dsh 版本号 → 能力」这个映射是稳定的、可以事先写死的。实际上不是。

### 2.2 实际做法：把 dsh 自己的判定函数拿过来跑一遍

dsh 的兼容性预检在 `@deepseek-ai/dsh-app-boot` 里。插件在启动时：

1. 动态 `import()` 本机 dsh 安装目录下的 `dsh-app-boot`；
2. 看它有没有导出 `evaluatePluginCompatibility` —— 有没有这件事**不靠版本号假设**；
3. 有的话，**用几个合成的假插件清单真调它一次**，看它到底会不会报、报什么：
   - 造一个 peer 范围是 `>=999.0.0` 的清单（任何真实 dsh 都不可能满足）→ 看它拦不拦；
   - 造一个完全没有 `peerDependencies` 的清单 → 看它管不管（这是它的盲区）；
   - 造一个只有 `dsh.engines.dsh` 的清单 → 看它看不看字段（也是盲区）；
   - 找找有没有 `compatibility` 文件常量 / 读写函数 → 判断有没有版本豁免机制。

于是「本机这个 dsh 有没有预检、会不会拦、有没有豁免」全是**实测结论**，不是版本推断。
报告里会明确标出结论依据：

```
适配信息（结论依据，不是假设）
  dsh 版本      : 0.2.0-rc.2｜来源：anchor-manifest
  能力探测      : 成功 —— 已就本机这个 dsh 实测校准
  兼容性预检    : 存在且实测有效
    · 会因 peer 不匹配拦下插件 : 会
    · 会检查没有 peer 的插件   : 不会（盲区）
    · 会看非标准版本声明       : 不会（盲区）
    · 版本豁免机制             : 有（compatibility.json）
```

探测不成功时**不下结论**：报告改说「本次未能实测」，措辞退到最保守的说法
（`会不会拦下它：未能实测`），并提示用 `--anchor <dsh 的 package.json>` 重跑一次。
三种状态是明确的 `covered` / `not-covered` / `unknown`，**不存在「猜一个」**。

### 2.3 顺带解决了一个更隐蔽的问题：措辞不能错

老版本 dsh **根本没有兼容性预检**。那里插件会照常加载，兼容性风险直接暴露在运行时。
如果在那种版本上还打「启动时会被拒绝加载」，就是**说反了** —— 用户会以为自己安全了。

所以告警措辞跟着实测走：

| 实测结论 | 告警措辞 |
| --- | --- |
| 该版本会拦 | `— 与 dsh X 不兼容，启动时会被拒绝加载` |
| 该版本不拦 | `— 与 dsh X 不兼容（本机 dsh 不会拦下它，会照常加载）` |
| 没测出来 | `— 与 dsh X 不兼容（本次未能实测本机 dsh 会不会拦下它）` |

同理，`allow-version` 这条修复建议**只在真的有豁免机制时才给** ——
在没有豁免机制的老版本上给这条命令，等于给一条根本跑不通的命令。

### 2.4 实测矩阵（本机真的装了 4 个 dsh 版本，逐个跑出来的）

| dsh 版本 | 兼容性预检函数 | 会因 peer 不匹配拦下 | 版本豁免机制 | 会看 `dsh.engines.dsh` 等野生声明 | 会看没有 `peerDependencies` 的插件 |
| --- | --- | --- | --- | --- | --- |
| `0.1.1-rc.2` | **没有** | 不会 | 没有 | 不会 | 不会 |
| `0.1.5-rc.3` | **没有** | 不会 | 没有 | 不会 | 不会 |
| `0.1.7-rc.1` | 有且实测有效 | 会 | 有（`compatibility.json`） | 不会 | 不会 |
| `0.2.0-rc.2` | 有且实测有效 | 会 | 有 | 不会 | 不会 |

这张表由 `npm test` 每次自动重测（`test/versions.test.mjs`），**不是文档里抄下来的死数据**：
将来你机器上多一个新版本 dsh，测试会自己把它加进来跑。遇到完全不认识的未来版本时，
测试只做自洽性检查并打一个 `⚠️` 提示，**不会因此失败**、也不需要谁来更新代码。

### 2.5 真机启动验证：光有结论不够，要真启动一次

单元测试里的 cordis 上下文是捏出来的假货。**「插件在真 dsh 启动流程里到底会不会被调用、
输出长什么样」只能真启动一次才算数**。所以还有一个真机验证脚本：

```bash
npm run verify:boot        # 把本机所有 dsh 版本各真启动一次
```

它在一个**临时的 `DSH_HOME`** 里、用 dsh 自带的 `headless` 模板起一个最小 profile，
塞进本插件 + 一个「对任何版本都不兼容」的金丝雀插件，然后**真的把这个 dsh 跑起来**，
核对四件事：

| dsh 版本 | 插件真被调用 | 告警措辞 | dsh 实际是否拦下金丝雀 | 探测结论 | 一致 |
| --- | --- | --- | --- | --- | --- |
| `0.1.1-rc.2` | ✅ | 会照常加载 | 否 | 不会拦 | ✅ |
| `0.1.5-rc.3` | ✅ | 会照常加载 | 否 | 不会拦 | ✅ |
| `0.1.7-rc.1` | ✅ | 会被拒绝加载 | 是 | 会拦 | ✅ |
| `0.2.0-rc.2` | ✅ | 会被拒绝加载 | 是 | 会拦 | ✅ |

最后两列是重点：**「探测说会拦」必须和「dsh 真的把金丝雀跳过了」对得上**。
这是「实测校准」这四个字唯一的硬证据 —— 校准自己错了，上面所有结论都是假的。

这个脚本不碰你的真实环境：全程在临时 `DSH_HOME` 里跑、不监听端口、
不动 `~/.dsh`、不影响正在运行的 Web GUI。

### 2.6 真机验证抓出来的 6 个 bug（这就是它存在的理由）

这几个都是**单元测试全绿也照样漏掉**的，只有真启动才暴露：

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `ctx.profileContext` 这种**服务属性读取会抛异常**（cordis 在插件没 `inject` 该服务时抛 `cannot get property "profileContext" without inject`；`0.1.5-rc.3` 实测如此） | 整个启动自检炸掉，又被 `apply()` 的兜底吞掉 —— **插件在那个版本上什么都不做，且一声不吭** | 改走 `serviceOf()`，逐个来源 `try/catch`，读不到就换下一个来源 |
| 2 | `0.1.1-rc.2` 上**根本没有 `profileContext`** 服务，插件退回继承来的 `DSH_PROFILE_DIR` | **张冠李戴**：在一个 `web` 会话里 `dsh --profile tui`，子进程继承的环境变量仍指向 `web`，插件就去体检 **web** 了，还理直气壮地报警 | 从**进程自己的命令行**反推 `--profile`，并让「显式指定 / 运行时事实」压过 `DSH_PROFILE_DIR` |
| 3 | 定位 dsh 安装目录只扫 `PATH` | 本机 npx 缓存里躺着 4 个 dsh，可能定位到**不是正在运行**的那个 —— 「实测校准」测错了对象，结论看着像实测，其实测的是别人 | 新增 `anchorFromProcessEntry()`：从当前进程入口脚本反推，权威性最高 |
| 4 | CLI 的 `--home / --profile` 被环境里的 `DSH_PROFILE_DIR` 悄悄盖掉 | 命令行参数看着生效了、其实没生效，检查的是另一个 profile | 「显式指定」的优先级提到环境变量之前 |
| 5 | **「复检不过就回滚」把一次正确的修复判成了失败**：`setBundleEnabled()` 返回 `restart-required`，紧接着问 `listBundles()`，拿到的还是**本进程的旧结论** | 于是一次**已经正确落盘的隔离**被自动回滚 —— 表面上"很安全"，实际上这个功能在真机上**永远修不成功**。单测全绿也发现不了（假 service 不会"慢半拍"） | 判定依据改成「**改动真的落盘** + 本插件复检干净」，dsh 本进程的即时结论只作为信息如实上报；并且 `listBundles()` 改为**轮询**若干秒，不采样一次就下结论 |
| 6 | **有阻断问题时，「快要不适配」的预警整块看不见** —— 横幅只渲染 `problems[0]`，"其余问题"也只列 `problems`，从不带 `upcoming` | 用户最想提前知道的那条消息（"dsh 升到 0.3.0 时 `dshmarket` 会被拦下"）被当前那条更紧急的盖住 —— 真机上两者是**同时存在**的 | 阻断视图底部加一行预警摘要 + 「查看 / 预防性处理」切换视图，两者同屏可达 |

第 5 个是**修复功能的真机验证**抓出来的（`npm run verify:repair`）；
第 6 个是**用真实数据预览横幅**抓出来的（`npm run preview`）——
单测用的假报文里 `upcoming` 一直是空的，所以"两种情况同屏"这件事从来没被测到过。
这两个例子说明为什么这个项目的验证要分四层：单元测试 → 真机启动 → **真机改造 + 再启动一次** →
**用真实数据渲染一遍界面**。

顺带把「一个坏来源拖垮整条链路」这件事也堵了：所有可选来源都各自 `try/catch` 降级
（`safe()`），任何一处出错只会退到下一个来源，不会让自检整体失能。

---

## 3. 相对 dsh 内置检查，多查了什么

dsh 的兼容性预检只检查 `peerDependencies` 中以 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-`
开头的键，而且**插件只要没有 `peerDependencies` 字段，就直接判定为兼容**
（源码里那句 `if (!Object.hasOwn(fields, "peerDependencies")) return void 0`）。

所以下面这些情况 dsh 全程不看（「会不会发现」一列是**逐版本实测**的，见 §2.4）：

| 检查项 | 说明 | dsh 是否会发现 |
| --- | --- | --- |
| `peerDependencies` 不满足 | peer 范围与运行时不符 | ✅ 会发现（**仅** `0.1.7-rc.1` 及以后；老版本连这个都不看） |
| **非标准位置的 dsh 版本声明** | `dsh.engines.dsh` / `dsh.compatibility.dsh` / `dshhub.compatibility.dsh` —— 三种野生写法实测都存在 | ❌ **4 个版本实测全部不会** |
| **完全没有 `peerDependencies` 的插件** | 无法从元数据判断兼容性，升 dsh 时最需要人工回归 | ❌ **4 个版本实测全部不会** |
| `engines.node` 不匹配 | Node 版本不符可能导致语法/API 不可用 | ❌ 不会 |
| `bundles` 里引用了但没装的包 | dsh 加载器会打印 `skipping profile bundle` 并跳过 | ⚠️ 加载器会打日志，但**那不是兼容性预检**，本插件只标「未能实测」不敢替 dsh 下断言 |
| **「快要不适配」（可预测的版本失配）** | 声明范围现在能满足，但 dsh 的下一个小版本 / 大版本就会掉出去 —— 也就是「下一个 `dsh-cost-meter`」 | ❌ **不会**（dsh 只判当前版本）。本插件按声明范围推算，并告诉你**坏在哪个版本**（例：`dshmarket@1.66.6` 会在 dsh `0.3.0` 失配） |
| 装了但不在 `bundles` 里 | 装了却不激活，白占依赖 | ❌ 不会 |
| profile 声明范围 vs 实际安装版本不一致 | lock 与 manifest 漂移 | ❌ 不会 |
| 读不到插件清单 | 包损坏 / 安装不完整 | ❌ 不会 |
| 版本豁免状态 | 区分「已知不兼容但接受风险」与「真的没问题」 | ⚠️ 部分（且老版本没有豁免机制） |

报告里每条发现都会标出「dsh 自己会不会发现」，三态且**带依据**：

```
[dsh 内置检查：同样会发现｜依据：dsh 兼容性预检（实测校准）]
[dsh 内置检查：不会发现｜依据：dsh 兼容性预检（实测：该版本没有这个检查）]
[dsh 内置检查：会不会发现未实测，不下断言｜依据：…]
```

**实测例子**：`@linxin666/dsh-perf@0.3.14` 声明了 `dsh.engines.dsh = ">=0.1.2-rc.1"`，
但**没有任何 dsh peer 依赖** —— 所以 dsh 侧从未校验过它。本插件会读这个字段。

---

## 4. 四种用法

### ① 装成插件：启动自动预警 + 会话内工具（推荐）

装进 profile 后，每次 dsh 启动会自动体检，有问题就往 stderr 打一段中文告警：

```
dsh-compat-doctor: 检测到 1 个插件与 dsh 0.2.0-rc.2 存在兼容性问题：
  [阻断] dsh-cost-meter@1.7.35 — 与 dsh 0.2.0-rc.2 不兼容，启动时会被拒绝加载
      建议：dsh plugin --profile web add dsh-cost-meter@latest
  完整报告：运行 `dsh-compat-doctor`，或在会话里用 plugin_compat_check 工具。
```

同时注册一个 `plugin_compat_check` 工具，会话里随时可以复查：

> 「帮我看看插件兼容性」→ agent 调用 `plugin_compat_check` → 返回完整中文报告与修复命令。

还有一个**系统提示词段落**：只要存在未解决的兼容性问题，它就会被注入到模型的上下文里，
模型会在你提到插件/报错/功能异常时**主动提醒**，不需要你想到去问。

### ② 独立 CLI：dsh 起不来时唯一能用的入口

插件只在 dsh **成功启动之后**才跑得起来；而版本冲突最坏的后果恰恰是 dsh 起不来。
所以同一个引擎同时提供独立 CLI —— 它**不依赖 dsh 的任何模块**：

```bash
dsh-compat-doctor                  # 检查默认 profile（$DSH_PROFILE 或 web）
dsh-compat-doctor --profile web    # 指定 profile（会压过环境里的 DSH_PROFILE_DIR）
dsh-compat-doctor --home <目录>     # 指定 ~/.dsh 所在目录
dsh-compat-doctor --anchor <路径>   # 指定 dsh 的 package.json（校准要用的那个）
dsh-compat-doctor --json           # 输出结构化 JSON
dsh-compat-doctor --all            # 连没有问题的插件也列出来
dsh-compat-doctor --quiet          # 只输出一行结论（给脚本用）
```

退出码：`0` 没问题 / `1` 发现问题 / `2` 体检未完成。可以拿来做启动前的守门脚本。
探测失败时会把「每个字段是从哪个来源推出来的」一并打印，方便定位。

### ③ 直接引用引擎

```js
import { auditProfile } from 'dsh-compat-doctor/audit'
import { auditProfileProbed } from 'dsh-compat-doctor/audit'   // 会先做实测校准
const report = auditProfile({ profileDir, profileName: 'web', installAnchor })
```

### ④ 页面上的一键修复（web profile 专属）

装了插件、用 `dsh web` 打开界面就会看到顶部横幅 —— **不用敲命令，直接按键修**：

```
┌────────────────────────────────────────────────────────────────────────────┐
│ [插件冲突] dsh 0.2.0-rc.2 与 dsh-cost-meter@1.7.35 冲突，它下次启动会被 dsh   │
│            拒绝加载。                                                  [×] │
│ 与运行时不兼容 —— 要求 ^0.1.0-rc.6 || ^0.1.1-0 || … ，当前 0.2.0-rc.2       │
│ [1] 隔离   [2] 卸载   [3] 升级   [R] 重新体检                              │
│ 不在输入框时可直接按数字键；正在输入时按 Alt+数字                          │
└────────────────────────────────────────────────────────────────────────────┘
```

| 按键 | 动作 | 可逆性 | 能保证消除冲突吗 |
| --- | --- | --- | --- |
| **`1` 隔离**（默认） | 用 dsh 自己的服务把它从 `dsh.profile.bundles` 摘掉，**包和依赖都留着** | 随时加回去 | ✅ **能** |
| `2` 卸载` | 走 `dsh plugin remove`，彻底删掉 | 要重装 | ✅ **能** |
| `3` 升级` | 装 `latest`（需要联网） | —— | ❌ 不能保证 |
| `R` | 立刻重新体检 | —— | —— |
| `Esc` | 收起（**同一批问题不再重复弹**；问题集合变了会重新弹） | —— | —— |

补充几点：

- **按键不会抢你的输入**：正在输入框里打字时裸数字键原样放过，只有 `Alt+数字` 才触发。
- **「快要不适配」不会被「已经冲突」盖住**：真机上两者会同时存在
  （`dsh-cost-meter@1.7.35` 已阻断 + `dshmarket@1.66.6` 将在 dsh `0.3.0` 失配），
  所以阻断视图底部会多一行预警摘要 + 一个「查看 / 预防性处理」入口，点进去是预警视图，
  可以「预防性处理」（把它提升成可操作的问题行，数字键继续有效）。
  想先看会显示成什么样：`npm run preview`（**只读**，用你真实 profile 的数据渲染一遍横幅，不发修复请求）。
- **结果直接显示在横幅上**（含每一步做了什么、是否已落盘、要不要重启、以及失败时的「已自动回滚」）；
  修完之后横幅不会立刻消失，免得你以为"什么都没发生"。
- **改动前自动备份** profile 的 `package.json` / `cordis.patch.yml` / `compatibility.json` 到
  `<profile>/.plugin-doctor-backup/<时间戳>/`；**改完自动复检**，保证类动作**复检不过就自动回滚**。
- 刻意**不提供**「豁免（`allow-version`）」这个选项：豁免只是"接受风险继续加载"，
  它**不会**让 dsh 下次启动不被拦下 —— 与本插件的目标正好相反。

> ⚠️ **接口只认本机回环**（`127.0.0.1`/`::1` + 同源校验）。所以从局域网地址打开的 GUI
> 会被拒绝（`403`），修复功能不可用但**页面其余部分照常**。这是刻意取舍：这条接口会改 profile 配置，
> 宁可不可用也不能给跨站请求留门。

---

## 5. 安装 / 卸载

### 从 npm 安装（给使用者的那条路）

已发布到 npm：**[dsh-compat-doctor](https://www.npmjs.com/package/dsh-compat-doctor)**

```bash
dsh plugin --profile web add dsh-compat-doctor
```

> **为什么改过名字**：原来的 `dsh-plugin-doctor` 这个名字在 npm 上**已经被别人占用**
> （作者 `Xrainsmile`，0.1.1），生态里另有两个同名插件。所以发布名改成了 `dsh-compat-doctor`。
> 插件的模块 id、`cordis.patch.yml`、页面接口前缀、横幅 DOM id 都已一并对齐新名字。
>
> 上架进度与投稿文件见 [`publish/`](publish/)：收录到插件市场（dshmarket 的清单来自
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）
> 需要往那边提一个 PR，加一个 YAML 条目；**npm 发布与收录是独立的**，
> 发不发 npm 都不影响收录，收录也不依赖 npm。

### 从源码安装（本机开发就是这样装的）

```bash
# link: 指向源码目录，改完代码重启 dsh 即生效
dsh plugin --profile web add link:D:/playwright-AI/playwright/dsh-compat-doctor

# 卸载（两种安装方式都用同一条命令）
dsh plugin --profile web remove dsh-compat-doctor
```

`dsh plugin add` 会**自动**把包名同时写进 `package.json` 的 `dependencies`
与 `dsh.profile.bundles` 两处（本机实测：两处都已按预期更新，且原有 8 个插件未受影响）；
`remove` 由同一套命令包装负责，会同步清理 bundles 条目。

> 本插件自己的 `dsh.engines.dsh` 写的是 `"*"` —— 一个声称「适配任意 dsh 版本」的插件
> 不该反过来给自己设版本门槛。

⚠️ Windows 上有个 **pnpm 自己的坑**（与插件无关，但会撞到）：
同一个目录如果被长短两种路径写法混用（`...\liujianqiao\...` 与 `...\LIUJIA~1\...`），
pnpm 会报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` 并拒绝 `add`/`remove`。
照它提示先在 profile 目录里跑一次 `pnpm install` 即可恢复。
（本插件的验证脚本因此先把临时目录解析成长路径再用——见 `scripts/verify-tarball-install.mjs`。）

---

## 6. 设计取舍（为什么代码长这样）

### 零 `@deepseek-ai/*` 依赖

这不是洁癖，是被逼的。**`link:` 安装的插件，其真实路径在 profile 之外**，
Node 的 ESM 解析从真实路径向上找 `node_modules` —— 找不到 dsh 自带的包。
实测 profile 的 `node_modules/@deepseek-ai/` 下**只有 `cosmokit` 和 `schemastery`**，
`dsh-tools` / `dsh-app-boot` / `dsh-system-prompt` / `semver` 全都不在。

所以：

- 工具定义**手写 JSON Schema**，不走 `defineTool`（它只是把 spec 转成 JSON Schema）；
- SemVer 范围求值是**自己实现的**（`lib/semver.js`），不用 `semver` 包；
- 服务用 `ctx.get()` **机会性获取**并降级，`inject` 留空 ——
  保证在任何残缺环境下插件都能加载起来，而不是「因为缺个服务就连带不加载」。
- 探测 `dsh-app-boot` 用的是**动态 `import()` + 绝对路径**，不是静态 import：
  静态 import 在本机根本解析不了。

### 体检工具不能自己成为故障源

`apply()` 全程 `try/catch`，启动自检、提示词段落、工具注册**各自独立兜底**，
任何一步失败只写一行 stderr 日志，**绝不向上抛**。系统提示词段落的 `text()`
失败时返回空串（空段落会被 dsh 丢弃，不占上下文）。

启动自检是**同步**做的：模块加载时（ESM 顶层 `await`）就把校准做完，
`apply()` 里不再等待任何异步 —— 否则像 `dsh web --help` 这种「挂载完就退」的路径
可能在告警写出来之前就退出了。

### 运行时版本未知时不下结论

拿不到 dsh 版本就**不做版本比对** —— 拿空串去比会把每个插件都误报成不兼容。
这种情况如实报「本次未判定版本兼容性」，并提示用 `--anchor` 恢复完整检查。
同理，定位不到 dsh 安装目录时，`@deepseek-ai/*` 的 bundle 只报「无法验证」，
不误报成「缺包」。

### 只读（默认）／要写就必须是你点的

**体检、命令行、会话内工具全都是只读的**：不改 profile 配置、不装不卸、不写 `compatibility.json`、
不联网；修复命令只打印，由你决定执不执行。

**唯一的写路径**是你**在页面横幅上明确按键选择**之后的那一次修复，而且：

1. 走 **dsh 自己的 `pluginManager` 服务**，不自己写文件（它加 profile 文件锁、原子写、还会协调 HMR；
   而 dsh 内部那个 `writeProfileManifest` 是**无锁非原子**的 `writeFileSync`——
   自己写就是绕过锁，万一插件页同时在写就会互相覆盖）；
2. 改前**自动备份**，改后**自动复检**，保证类动作**复检不过自动回滚**；
3. 接口**只认本机回环 + 同源**，请求体上限 4 KiB；
4. 只有完全没有 `pluginManager` 的老宿主才退回自己原子写，并**在结果里明确说明**这一点。

---

## 7. 验证情况

```bash
npm test               # 134 个用例（含 4 个真实 dsh 版本的实测对拍）
npm run test:fast      # 跳过版本对拍，只跑纯逻辑
npm run verify:boot    # 真机启动验证（把本机每个 dsh 版本各真启动一次）
npm run verify:repair  # 真机「一键修复」验证（隔离环境里真修一次 + 再启动一次）
npm run verify:tarball # 打包安装验证：npm pack 出来 → dsh 自己装 → 真启动（22 项）
npm run preview        # 只读：用真实 profile 的数据把页面横幅渲染出来给你看
```

只想验**线上那个包**能不能被陌生人装上（不走本地源码）：

```bash
node scripts/verify-tarball-install.mjs --from-npm dsh-compat-doctor@beta
# 用 dsh 自己的 `dsh plugin add` 装 npm 上已发布的版本 → 空白 profile → 真启动 → 取横幅代码 → 卸载
```

| 测试文件 | 覆盖 |
| --- | --- |
| `test/semver.test.mjs` | **与本机 dsh 自带的真 `semver` 穷举对拍 1312 组 `satisfies` + 41 组 `validRange`，零差异**（两种 `includePrerelease` 模式都测）；SemVer §11 优先级；反直觉语义的回归断言 |
| `test/adapt.test.mjs` | 定位与上下文推导的全部来源与优先级；**服务属性读取抛异常时不能失能**（§2.6 的 bug 1）；**命令行压过环境变量**（bug 4）；从进程入口反推 dsh（bug 3）；从命令行反推 profile（bug 2） |
| `test/audit.test.mjs` | 每种发现各一个用例；豁免文件的**真实格式**（裸 map，不是 `{exemptions:…}` 包装）；**同一份插件代码在不同能力下给出相反结论**（自适应核心）；未实测就不下断言；损坏输入不抛 |
| `test/plugin.test.mjs` | 工具定义形状、`execute`/`render`、提示词段落内容；**残缺上下文下 `apply()` 不抛异常**；启动告警是同步的；配置开关；拿不到 profile 时报可读错误；**页面路由挂载 / 释放 / 关掉 / 老 cordis 安静降级 / `pluginManager` 延迟可取** |
| `test/upgrade.test.mjs` | 「快要不适配」的预测：用**两个真实插件声明的范围**（`dsh-cost-meter` 的长 `||` 串、`@linxin666/dsh-perf` 的 `>=`）断言分级；固定版本 / 只允许补丁 / 通配 / 垃圾输入各自的分级 |
| `test/repair.test.mjs` | 三个动作打到 dsh 的**对的方法**上；备份/还原往返；兜底直写是 2 空格 + 结尾换行；拒绝码与人话翻译；**「已落盘但 dsh 还没重估」必须判成功**（§2.6 的 bug 5）；复检不干净 / 没落盘 / 服务拒绝 → 回滚 |
| `test/routes.test.mjs` | 回环与同源围栏（跨站、伪造 Origin、非法 Host 全拒）；请求体超限；状态报文里**插件版本号与 dsh 版本号都在**；修复请求的参数校验与作业生命周期 |
| `test/client.test.mjs` | 用最小假 DOM 跑**真的 `client.js`**：横幅同时写明插件版本号与 dsh 版本号；`1` 映射到隔离；**在输入框里裸数字键不被抢走、`Alt+数字` 有效**；`Esc` 记住指纹不重复打扰；接口挂了安静退场；客户端产物**没有 import** |
| `test/versions.test.mjs` | 对上表 4 个真实 dsh 版本逐个实测：预检有无、会不会拦、豁免机制、三个盲区；**与 dsh 自己的豁免文件读取器对比 18 组样本，结论全部一致**；未来新版本只做自洽检查、自动纳入 |

真实环境端到端已确认：

- `dsh --profile web --dump-config` → 组合树里出现 `- id: plugin-doctor / name: dsh-compat-doctor`；
- **真机启动**（`npm run verify:boot`）→ 4 个 dsh 版本上插件都被真正调用、措辞全部正确、
  且「探测结论」与「dsh 真实是否拦下金丝雀」逐版本一致（见 §2.5）；
- **真机「一键修复」**（`npm run verify:repair`）→ 在一个临时 `DSH_HOME` 里造一个必然不兼容的插件、
  真启动 `dsh web`、走 HTTP 接口修一次、**再真启动一次**，全部通过：
  状态报文里带着插件版本号与 dsh 版本号 → 修复走的是 dsh 自己的 `pluginManager` →
  改动真的落盘 → 第二次启动**不再跳过它**、启动告警消失、体检 0 冲突；
- **客户端横幅真的会被浏览器加载**：dsh 的启动注入里带着
  `dsh-compat-doctor/client.js`（真实 `rev` 从页面里取），按该 URL 取回 `HTTP 200`、  41 万字节，内容就是本插件的横幅代码；
- **打包产物装得上、装完能用**（`npm run verify:tarball`，22 项）→ `npm pack` 出真 tarball、
  用 dsh 自己的安装命令装进空白 profile、真启动、取到横幅代码、再卸载干净；
- **npm 上已发布的那一个包也一样能用**（`--from-npm dsh-compat-doctor@beta`，16 项）→
  这条路就是陌生人点「一键安装」走的路：装出来的是 registry 上的真拷贝
  （`node_modules/.pnpm/dsh-compat-doctor@0.3.0/…`，不是指回本机源码目录），
  启动后体检 0 冲突、横幅代码 `HTTP 200`、卸载干净；
- **用真实数据把界面渲染了一遍**（`npm run preview`）→ 你的 profile 上横幅会同时报出
  `dsh-cost-meter@1.7.35`（已阻断）与 `dshmarket@1.66.6`（将在 dsh `0.3.0` 失配），
  并给出了 `[1] 隔离 [2] 卸载 [3] 升级`；30 个依赖里只有 `dshmarket` 一个触发预警，不是噪音；
- CLI 在真实 profile 上 → 9 条、阻断 1（`dsh-cost-meter@1.7.35`）、退出码 1；
- 会话内 `plugin_compat_check` 工具实际调用成功，与「DSH 插件兼容性问题」提示词段落
  均已在该会话生效；
- 结论与 dsh 自身的 `skipping profile bundle "dsh-cost-meter"` 日志**逐条一致**。

阶段性验证报告：`report/页面预警与一键修复-验证报告-20260930.md`（含逐条要求对照、真机输出、诚实边界）。

---

## 8. 本次改过什么 / 如何回滚

本插件在开发过程中被装进了**用户的在用 profile** `~/.dsh/profiles/web`。改动与回滚：

**改了什么**（2026-09-30）：

| 文件 | 改动 |
| --- | --- |
| `~/.dsh/profiles/web/package.json` | `dependencies` 增加 `dsh-compat-doctor: link:D:/playwright-AI/playwright/dsh-compat-doctor`；`dsh.profile.bundles` 末尾增加 `dsh-compat-doctor` |
| `~/.dsh/profiles/web/pnpm-lock.yaml` | 增加该 link 依赖的 lock 条目 |
| `~/.dsh/profiles/web/node_modules/dsh-compat-doctor` | 新建 Junction，指向源码目录 |

**同日改名同步**（发布前把旧名 `dsh-plugin-doctor` 换成 `dsh-compat-doctor`，因为旧名在 npm 上已被别人占用）：

| 文件 | 改动 |
| --- | --- |
| `~/.dsh/profiles/web/package.json` | 依赖键与 bundles 条目：`dsh-plugin-doctor` → `dsh-compat-doctor`（`link:` 目标路径不变） |
| `~/.dsh/profiles/web/pnpm-lock.yaml` | 同一条 lock 条目的键名同步 |
| `~/.dsh/profiles/web/node_modules/` | 旧 Junction `dsh-plugin-doctor` 删除，新建 `dsh-compat-doctor`（同一目标） |

同步后已用**只读**方式复核：`dsh --profile web --dump-config` 里出现
`- id: plugin-doctor / name: dsh-compat-doctor`，唯一的启动告警仍是**本来就存在**的
`dsh-cost-meter`，没有新增问题。

**没有改**：原有 8 个插件一个没动（版本、解析路径全部不变）、`cordis.yml`、
`cordis.patch.yml`、`pnpm-workspace.yaml` 均未改动；`compatibility.json` 未创建。

> ⚠️ **这一轮新增的「一键修复」会在你按键之后改 profile 配置**（这正是它的用途）：
> 按 `1` 隔离会动 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，
> 按 `2` 卸载会走 dsh 的 `remove`。每次改动前都会自动把 `package.json` /
> `cordis.patch.yml` / `compatibility.json` 备份到
> `~/.dsh/profiles/web/.plugin-doctor-backup/<时间戳>/`；复检不过会自动回滚。
> **本轮开发过程中没有对用户的真实 profile 执行过任何修复动作** ——
> 真机修复验证全程跑在临时 `DSH_HOME` 里（`npm run verify:repair`）。

**改前快照**：`_profile-backup/20260930-152606/`（安装前，含 `package.json` / `pnpm-lock.yaml` /
`pnpm-workspace.yaml` / `cordis.yml` / `cordis.patch.yml`）与
`_profile-backup/20260930-rename/`（改名同步前）。

**回滚**（二选一）：

```bash
# 方式一：正规卸载（推荐）
dsh plugin --profile web remove dsh-compat-doctor

# 方式二：直接用快照还原（连 lock 一起回到改前状态）
copy /Y _profile-backup\20260930-152606\package.json       %USERPROFILE%\.dsh\profiles\web\package.json
copy /Y _profile-backup\20260930-152606\pnpm-lock.yaml     %USERPROFILE%\.dsh\profiles\web\pnpm-lock.yaml
cd %USERPROFILE%\.dsh\profiles\web && pnpm install
```

> `_profile-backup/` 已被 `.gitignore` 排除：它里面是本机真实 profile 的配置快照，
> 不进公开仓库（`report/` 同理，含本机路径与已装插件清单）。

`dsh-cost-meter@1.7.35` 的不兼容**不是本次改动造成的** —— 它在安装本插件之前
就已经被 dsh 启动预检拒绝加载了（见 §1 的 dsh 原始日志）。本插件只是把它报了出来，
**没有修改、也没有尝试修复它**。

---

## 9. 已知限制

- **`0.1.7-rc.1` 之前没有兼容性预检，也没有版本豁免机制。** 那些版本上不兼容的插件
  **会照常加载**，风险直接暴露在运行时；`allow-version` 这条路也不适用。
  本插件会如实这么说，但**它无法替你拦下任何东西** —— 它只负责告诉你。
- **SemVer 求值器覆盖常见语法**（`^` `~` `>=` `>` `<=` `<` `=`、`||`、空格分隔、
  `x`/`X`/`*` 通配、`-` 连字符区间、预发布优先级），且已与真 `semver` 对拍 1300+ 组
  零差异；但 npm 还有一些极冷门写法（如复杂嵌套、`npm:` 别名里的范围）未逐一对拍。
- **不联网**（只有你按键选「升级」那一次会联网，因为那要装包）。因此常规体检只能告诉你
  「去升级」，**不会自动算出哪个版本才是兼容的** —— 那需要查 registry 的版本元数据。
- **「100%」的准确边界**（§4④，这里必须说实话）：
  - 能保证的是：**隔离 / 卸载之后，dsh 启动时的兼容性预检一定不会再因为这个插件拦下它** ——
    依据是 profile 清单真的改了（下次启动读的就是它），并且再启动一次已经实测验证过；
  - **不能**保证的是：插件升级到新版后就一定兼容（要装完才能验），
    也**不能**保证某个插件的运行时问题不会把 dsh 弄崩 —— 本插件管的是版本冲突导致启动失败这一件事；
  - 因此**不提供「豁免（`allow-version`）」这个选项**：豁免是"接受风险继续加载"，
    它不会让启动不被拦下，与目标相反。
- **修复接口只认本机回环**：从局域网地址打开的 GUI 拿不到修复功能（返回 `403`），
  页面其余部分照常。这是刻意取舍（该接口会改 profile 配置）。
- **修改能力依赖 dsh 自己的 `pluginManager`**：完全没有这个服务的老宿主上，
  隔离退化为**自己原子写** profile 清单（结果里会明确标注「未走 dsh 服务」），
  而卸载/升级会直接报错让你改用命令行 —— 不会假装成功。
- **升级不受「保证」保护**：它需要 `pnpm` 与网络，且装完之前无法预知新版兼不兼容；
  它会如实报告结果，必要时你可以接着按「1」隔离。
- **`@deepseek-ai/*` 的 bundle 被当作 dsh 安装自带**（依据实测的 `DEFAULT_PROFILE_BUNDLES`
  与安装目录里是否真的存在该包，不是写死的名单）。若第三方占用了该 scope，会漏报。
- **校准是「本机这个 dsh」的实测结论。** 换一台机器、换一个 dsh 版本，结论会重测；
  但同一台机器上如果 `dsh-app-boot` 被改动过（少见），结论就以那次实测为准。
- 定位 dsh 安装目录的顺序：**当前进程入口** → `DSH_INSTALL_ANCHOR` / `DSH_ANCHOR` →
  `PATH` 上的 `dsh` → npx 缓存 → 常见 npm 全局目录；都不中时用 `--anchor` 显式指定。

---

## 10. 目录结构

```
dsh-compat-doctor/                # 目录名仍是旧名（Junction 指向它，改名会牵连本机安装）
├── package.json                  # dsh.bundle.patch + dsh.client 声明 + bin 入口 + npm 元数据
├── cordis.patch.yml              # 把插件插进 profile 的 bundle 层
├── LICENSE                       # MIT
├── .gitignore                    # 排除私有快照与报告（见下）
├── .gitattributes                # 一律 LF 入库
├── lib/
│   ├── index.js                  # cordis 宿主插件：启动自检 + 工具 + 提示词段落 + 页面接口挂载
│   ├── adapt.js                  # 适配层：定位 + 上下文来源推导 + 运行时能力实测校准
│   ├── audit.js                  # 审计引擎（纯函数 + 文件读取，永不抛）
│   ├── upgrade.js                # 「快要不适配」预测：按声明范围推算何时会坏
│   ├── repair.js                 # 修复层：备份 → 走 dsh 服务改 → 落盘校验 + 复检 → 不过就回滚
│   ├── routes.js                 # 宿主 HTTP 接口：状态 / 发起修复 / 查询作业（回环 + 同源围栏）
│   ├── client.js                 # 页面横幅（手写 lazy-CJS，零依赖、无构建步骤）
│   ├── semver.js                 # 自包含 SemVer 范围求值器（与真 semver 对拍过）
│   ├── report.js                 # 中文报告渲染 + 修复命令生成（措辞随实测能力变）
│   ├── locate.js                 # 定位 dsh 安装目录（含从进程入口反推）
│   └── cli.js                    # 独立 CLI（dsh 起不来时用）
├── scripts/
│   ├── verify-real-boot.mjs      # 真机启动验证：每个 dsh 版本各真启动一次
│   ├── verify-real-repair.mjs    # 真机修复验证：真改一次 + 再启动一次（见 §2.6 bug 5）
│   ├── verify-tarball-install.mjs# 打包安装验证；--from-npm 可直接验线上那个包
│   ├── preview-banner.mjs        # 只读：用真实 profile 的数据把横幅渲染出来看
│   └── helpers/
│       ├── dsh-harness.mjs       # 真机验证公共件（临时 home / 启停 dsh / 建 profile）
│       └── fake-dom.mjs          # 最小假 DOM（测试与 preview 工具共用一份）
├── test/                         # 134 个用例（含 4 个真实 dsh 版本的实测对拍）
├── publish/                      # 投稿插件市场的文件与步骤（含那条 YAML 条目）
├── report/                       # 阶段性验证报告（含本机路径，故 gitignore）
└── _profile-backup/              # 本机 profile 配置快照（含插件清单，故 gitignore）
```
