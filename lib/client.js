// dsh-compat-vet 的浏览器端：把宿主的体检结论显示在 DSH 页面上，并把用户的
// 键盘选择送回宿主执行修复。
//
// 手写在 lazy-CJS 协议里（window.__ModuleLoader__.load + 返回 cordis 插件形态的
// exports），所以**没有构建步骤、不 import 任何 dsh 客户端包** —— 与本插件宿主侧的
// 「零 @deepseek-ai 静态依赖」立场一致。这三行协议照抄本机两个能正常工作的插件
// （@liustack/modlens、dsh-whale-mascot）。
//
// 职责边界：浏览器**只负责显示和收键盘**。判定、改 profile、跑 pnpm 全在宿主侧，
// 通过 /dsh-compat-vet/api/v1/status 与 /repair 两个接口往返。这样界面坏了也
// 不会伤到 profile。
window.__ModuleLoader__.load({
  id: 'dsh-compat-vet',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var API = '/dsh-compat-vet/api/v1'
    var ROOT_ID = 'dsh-compat-vet-banner'
    var STYLE_ID = 'dsh-compat-vet-style'
    var DISMISS_KEY = 'dsh-compat-vet:dismissed'
    var POLL_MS = 60000

    var state = {
      mounted: false,
      status: null,
      /** 当前横幅上可用动作的键位映射：{'1':'quarantine', ...} */
      bindings: {},
      /** 正在执行的作业 */
      job: null,
      pollTimer: null,
      jobTimer: null,
      dismissed: null,
      busy: false,
      flash: null,
    }

    //#region 小工具

    function esc(text) {
      return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    /**
     * 用户此刻是不是正在输入框里打字。
     * 这决定了裸数字键要不要让路 —— 绝不能把用户正常输入的数字吃掉。
     */
    function isEditing() {
      var el = document.activeElement
      if (!el) return false
      var tag = (el.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (el.isContentEditable === true) return true
      return false
    }

    function readDismissed() {
      try {
        var raw = window.localStorage.getItem(DISMISS_KEY)
        return raw === null ? null : JSON.parse(raw)
      } catch (error) {
        return null
      }
    }

    function writeDismissed(value) {
      try {
        if (value === null) window.localStorage.removeItem(DISMISS_KEY)
        else window.localStorage.setItem(DISMISS_KEY, JSON.stringify(value))
      } catch (error) {
        /* 隐私模式下 localStorage 会抛，忽略即可 */
      }
    }

    /** 一组问题的指纹：问题集合变了就要重新弹出来，而不是被永久忽略。 */
    function fingerprint(status) {
      if (!status) return ''
      var problems = (status.problems || []).map(function (p) { return p.name + '@' + (p.version || '?') + ':' + p.severity })
      var upcoming = (status.upcoming || []).map(function (p) { return p.name + ':' + p.level })
      return status.dshVersion + '|' + problems.join(',') + '|' + upcoming.join(',')
    }

    //#endregion

    //#region 样式

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '#' + ROOT_ID + '{position:fixed;top:0;left:0;right:0;z-index:2147483000;',
        'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;',
        'color:#f5f5f5;background:#2a1416;border-bottom:1px solid #7f1d1d;',
        'box-shadow:0 6px 20px rgba(0,0,0,.45);padding:10px 14px}',
        '#' + ROOT_ID + '.dpd-warn{background:#2b2410;border-bottom-color:#a16207}',
        '#' + ROOT_ID + ' .dpd-head{display:flex;align-items:flex-start;gap:10px}',
        '#' + ROOT_ID + ' .dpd-title{font-weight:600;flex:1;min-width:0}',
        '#' + ROOT_ID + ' .dpd-badge{display:inline-block;padding:1px 7px;border-radius:10px;',
        'background:#7f1d1d;color:#fff;font-size:12px;margin-right:8px;vertical-align:1px}',
        '#' + ROOT_ID + '.dpd-warn .dpd-badge{background:#a16207}',
        '#' + ROOT_ID + ' .dpd-sub{color:#d8cccc;margin-top:4px;word-break:break-word}',
        '#' + ROOT_ID + ' .dpd-mono{font-family:ui-monospace,Consolas,monospace;color:#ffd9d9}',
        '#' + ROOT_ID + ' .dpd-keys{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px;align-items:center}',
        '#' + ROOT_ID + ' button{font:inherit;cursor:pointer;border-radius:6px;padding:4px 10px;',
        'border:1px solid #6b7280;background:#374151;color:#f3f4f6}',
        '#' + ROOT_ID + ' button:hover:not(:disabled){background:#4b5563}',
        '#' + ROOT_ID + ' button:disabled{opacity:.5;cursor:default}',
        '#' + ROOT_ID + ' button.dpd-primary{background:#b91c1c;border-color:#dc2626}',
        '#' + ROOT_ID + ' button.dpd-primary:hover:not(:disabled){background:#dc2626}',
        '#' + ROOT_ID + ' .dpd-hint{color:#a8a29e;font-size:12px}',
        '#' + ROOT_ID + ' .dpd-close{margin-left:auto;background:transparent;border:none;color:#d6d3d1;font-size:16px;padding:0 4px}',
        '#' + ROOT_ID + ' .dpd-log{margin-top:8px;max-height:132px;overflow:auto;background:#111827;',
        'border-radius:6px;padding:6px 9px;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#d1d5db}',
        '#' + ROOT_ID + ' .dpd-log div{padding:1px 0}',
        '#' + ROOT_ID + ' .dpd-extra{margin-top:8px;font-size:12px;color:#e7cfcf}',
        '#' + ROOT_ID + ' .dpd-extra button{padding:2px 8px;font-size:12px;margin-left:6px}',
        '#' + ROOT_ID + ' .dpd-ok{color:#86efac}',
        '#' + ROOT_ID + ' .dpd-bad{color:#fca5a5}',
      ].join('')
      document.head.appendChild(style)
    }

    //#endregion

    //#region 渲染

    function root() {
      return document.getElementById(ROOT_ID)
    }

    function removeBanner() {
      var el = root()
      if (el && el.parentNode) el.parentNode.removeChild(el)
      state.bindings = {}
    }

    function closeBanner(remember) {
      if (remember === true && state.status) {
        state.dismissed = fingerprint(state.status)
        writeDismissed(state.dismissed)
      }
      removeBanner()
    }

    function actionsFor(item) {
      return item.actions || ['quarantine', 'uninstall', 'upgrade']
    }

    function buttonHtml(key, action, text, primary) {
      return '<button type="button" class="' + (primary ? 'dpd-primary' : '') + '" data-dpd-action="' + esc(action) + '"'
        + ' data-dpd-target="' + esc(state.currentTarget || '') + '">'
        + '<b>[' + esc(key) + ']</b> ' + esc(text) + '</button>'
    }

    /**
     * 渲染横幅。
     *
     * 硬要求（用户提的）：**必须写清是哪个插件的哪个版本、以及当前 dsh 的哪个版本**。
     * 所以标题行永远是 `dsh <版本> 与 <插件>@<版本> 冲突` 这个形状。
     */
    function render() {
      var status = state.status
      if (!status) { removeBanner(); return }

      var problems = status.problems || []
      var upcoming = status.upcoming || []
      // 修好之后问题会清零。这时候**不能直接把横幅撤掉** —— 那用户会以为「什么都没发生」。
      // 有修复结果时转为「结果横幅」，等用户自己关掉。
      if (problems.length === 0 && upcoming.length === 0) {
        if (state.flash) { renderResultOnly(); return }
        removeBanner()
        return
      }
      if (state.dismissed !== null && state.dismissed === fingerprint(status)) { removeBanner(); return }

      ensureStyle()
      // state.showPre = 用户主动切到「升级预警」视图。
      // 为什么需要它：有阻断问题时它会把预警挡住，而「快要不适配」恰恰是用户最想提前知道的事
      // （真机上就出现过：dsh-cost-meter 阻断 + dshmarket 将在 dsh 0.3.0 失配，
      //  结果只看得见前者）。所以两者都要能看到，且**默认先看更紧急的那个**。
      var showProblems = problems.length > 0 && state.showPre !== true
      var primary = showProblems ? problems[0] : null
      var lead = primary || upcoming[0]
      state.currentTarget = lead.name
      var isWarnOnly = primary === null

      var dshVersion = status.dshVersion || '（未知版本）'
      var rows = []

      if (primary) {
        var actionKeys = {}
        var buttons = []
        var acts = actionsFor(primary)
        var labels = { quarantine: '隔离', uninstall: '卸载', upgrade: '升级' }
        for (var i = 0; i < acts.length; i += 1) {
          var key = String(i + 1)
          actionKeys[key] = acts[i]
          buttons.push(buttonHtml(key, acts[i], labels[acts[i]] || acts[i], acts[i] === primary.defaultAction))
        }
        state.bindings = actionKeys

        rows.push('<div class="dpd-head">')
        rows.push('<div class="dpd-title"><span class="dpd-badge">插件冲突</span>'
          + 'dsh <span class="dpd-mono">' + esc(dshVersion) + '</span> 与 '
          + '<span class="dpd-mono">' + esc(primary.name) + '@' + esc(primary.version || '未知版本') + '</span> 冲突，'
          + (status.adaptation && status.adaptation.deniesAtStartup === true
            ? '它下次启动会被 dsh 拒绝加载'
            : '它下次启动可能被 dsh 拒绝加载')
          + '。</div>')
        rows.push('<button type="button" class="dpd-close" data-dpd-close="1" title="暂时收起（Esc）">&times;</button>')
        rows.push('</div>')
        rows.push('<div class="dpd-sub">' + esc(primary.title || '') + ' —— ' + esc(primary.detail || '') + '</div>')
        rows.push('<div class="dpd-keys">' + buttons.join('')
          + '<button type="button" data-dpd-refresh="1"><b>[R]</b> 重新体检</button>')
        if (problems.length > 1) {
          rows.push('<button type="button" data-dpd-next="1"><b>[N]</b> 下一个问题（还有 ' + (problems.length - 1) + ' 个）</button>')
        }
        rows.push('<span class="dpd-hint">不在输入框时可直接按数字键；正在输入时按 Alt+数字</span></div>')

        if (state.busy || state.job) {
          var log = state.job && state.job.steps ? state.job.steps : []
          rows.push('<div class="dpd-log">')
          if (log.length === 0) rows.push('<div>正在执行…</div>')
          for (var j = 0; j < log.length; j += 1) {
            rows.push('<div>· ' + esc(log[j].label) + (log[j].detail ? ' —— ' + esc(log[j].detail) : '') + '</div>')
          }
          rows.push('</div>')
        }

        if (state.flash) {
          rows.push('<div class="dpd-sub ' + (state.flash.ok ? 'dpd-ok' : 'dpd-bad') + '">'
            + esc(state.flash.text) + '</div>')
        }

        if (problems.length > 1) {
          rows.push('<div class="dpd-extra">其余问题：')
          for (var k = 1; k < problems.length; k += 1) {
            rows.push('<span>' + esc(problems[k].name) + '@' + esc(problems[k].version || '未知版本')
              + '<button type="button" data-dpd-pick="' + k + '">处理它</button></span> ')
          }
          rows.push('</div>')
        }
        // 「快要不适配」不能被阻断问题盖住 —— 给一行摘要 + 一个入口（切换视图，不抢当前焦点）
        if (upcoming.length > 0) {
          var soon = upcoming[0]
          rows.push('<div class="dpd-extra">另有 ' + String(upcoming.length) + ' 个插件现在还能加载、'
            + '<b>升级 dsh 之后会被拒绝加载</b>：'
            + '<span class="dpd-mono">' + esc(soon.name) + '@' + esc(soon.version || '未知版本') + '</span>'
            + (soon.breaksAt ? '（dsh 升到 ' + esc(soon.breaksAt) + ' 时）' : '')
            + '<button type="button" data-dpd-showpre="1">查看 / 预防性处理</button></div>')
        }
      } else {
        state.bindings = {}
        rows.push('<div class="dpd-head">')
        rows.push('<div class="dpd-title"><span class="dpd-badge">升级预警</span>'
          + '当前 dsh <span class="dpd-mono">' + esc(dshVersion) + '</span> 还能加载这些插件，'
          + '但升级 dsh 之后它们会被拒绝加载：</div>')
        rows.push('<button type="button" class="dpd-close" data-dpd-close="1" title="暂时收起（Esc）">&times;</button>')
        rows.push('</div>')
        for (var u = 0; u < upcoming.length && u < 5; u += 1) {
          var item = upcoming[u]
          rows.push('<div class="dpd-sub">· <span class="dpd-mono">' + esc(item.name) + '@' + esc(item.version || '未知版本')
            + '</span>：' + esc(item.reason || item.levelText || '')
            + (item.breaksAt ? '（dsh 升到 ' + esc(item.breaksAt) + ' 时失效）' : '')
            + '<button type="button" data-dpd-pre="' + u + '">预防性处理</button></div>')
        }
        rows.push('<div class="dpd-keys"><button type="button" data-dpd-refresh="1"><b>[R]</b> 重新体检</button>'
          + (problems.length > 0
            ? '<button type="button" data-dpd-showproblems="1">返回冲突问题（' + String(problems.length) + ' 个）</button>'
            : '')
          + '<span class="dpd-hint">点「预防性处理」后可继续用数字键选择动作</span></div>')
        if (state.flash) {
          rows.push('<div class="dpd-sub ' + (state.flash.ok ? 'dpd-ok' : 'dpd-bad') + '">' + esc(state.flash.text) + '</div>')
        }
      }

      var el = root()
      if (el === null) {
        el = document.createElement('div')
        el.id = ROOT_ID
        el.setAttribute('role', 'alert')
        document.body.appendChild(el)
      }
      el.className = isWarnOnly ? 'dpd-warn' : ''
      el.innerHTML = rows.join('')
    }

    //#endregion

    //#region 与宿主往返

    function fetchStatus(force) {
      return window.fetch(API + '/status' + (force === true ? '?force=1' : ''), {
        headers: { accept: 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('status HTTP ' + res.status)
        return res.json()
      })
    }

    function refresh(force) {
      return fetchStatus(force === true).then(function (status) {
        state.status = status
        // 已经收起过、且问题集合没变的，不要又弹出来
        if (state.dismissed !== null && state.dismissed !== fingerprint(status)) state.dismissed = null
        render()
        return status
      }).catch(function () {
        // 拿不到就不显示：本插件绝不能因为自己的接口坏了而干扰 DSH 页面
        return null
      })
    }

    function startRepair(action, name) {
      if (state.busy) return
      state.busy = true
      state.flash = null
      state.job = { steps: [] }
      render()
      window.fetch(API + '/repair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, name: name }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || body.ok !== true) throw new Error(body.error || ('HTTP ' + res.status))
          return body
        })
      }).then(function (body) {
        state.job = { steps: [], id: body.jobId }
        render()
        pollJob(body.jobId)
      }).catch(function (error) {
        state.busy = false
        state.job = null
        state.flash = { ok: false, text: '修复请求没能发出：' + error.message }
        render()
      })
    }

    function pollJob(jobId) {
      if (state.jobTimer) window.clearTimeout(state.jobTimer)
      window.fetch(API + '/repair?id=' + encodeURIComponent(jobId), { headers: { accept: 'application/json' } })
        .then(function (res) { return res.json() })
        .then(function (body) {
          if (body.ok !== true || !body.job) throw new Error(body.error || '作业查询失败')
          state.job = body.job
          render()
          if (body.job.state === 'running') {
            state.jobTimer = window.setTimeout(function () { pollJob(jobId) }, 800)
            return
          }
          state.busy = false
          var result = body.job.result || {}
          if (result.ok === true) {
            var tail = result.applicationText ? '；' + result.applicationText : ''
            // 判定成功的是「改动已落盘 + 本插件复检干净」（result.verified）。
            // dsh 在本进程里的即时结论可能是**还没同步**（restart-required），
            // 那不代表没修好 —— 所以它只作为补充说明，绝不能因此把横幅标成失败。
            var confirm = result.clearedByDsh === true
              ? '，dsh 复查也确认不再判它不兼容'
              : (result.verified === true ? '，改动已写入 profile 配置，dsh 会按新状态加载' : '')
            state.flash = {
              ok: true,
              text: '✅ 已处理 ' + (result.target ? result.target.name : '') + tail + confirm
                + (result.guaranteed === true ? '。下次启动不会再因为它被拦下。' : '。'),
            }
          } else {
            state.flash = {
              ok: false,
              text: '❌ 修复未完成：' + (result.error || '未知原因') + (result.rolledBack === true ? '（已自动回滚到修复前）' : ''),
            }
          }
          render()
          // 刻意**保留** state.job：执行步骤是「真的做了这些事」的证据，
          // 要留在横幅上直到用户关掉或发起下一次操作。
          refresh(true)
        })
        .catch(function (error) {
          state.busy = false
          state.job = null
          state.flash = { ok: false, text: '查询修复进度失败：' + error.message }
          render()
        })
    }

    //#endregion

    //#region 键盘

    /**
     * 键位处理。
     *
     * 两条路径：
     *   · 焦点不在输入框 → 直接按数字键（用户要的「快捷」）
     *   · 焦点在输入框   → 必须带 Alt（否则会把用户正在输入的数字吃掉）
     * 这是刻意的取舍：快捷键不能以干扰正常打字为代价。
     */
    function onKeyDown(event) {
      var el = root()
      if (el === null) return
      if (event.defaultPrevented) return

      if (event.key === 'Escape') {
        closeBanner(true)
        return
      }

      var editing = isEditing()
      var alt = event.altKey === true

      // 正在输入时，只有 Alt+键 才算快捷键
      if (editing && !alt) return
      if (event.ctrlKey === true || event.metaKey === true) return

      var key = event.key

      if (key === 'r' || key === 'R') {
        event.preventDefault()
        state.flash = null
        refresh(true)
        return
      }
      if (key === 'n' || key === 'N') {
        event.preventDefault()
        var problems = (state.status && state.status.problems) || []
        if (problems.length > 1) {
          state.status.problems = problems.slice(1).concat(problems.slice(0, 1))
          render()
        }
        return
      }
      if (key >= '1' && key <= '9') {
        var action = state.bindings[key]
        if (action === undefined) return
        event.preventDefault()
        event.stopPropagation()
        startRepair(action, state.currentTarget)
      }
    }

    // 点按钮
    function onClick(event) {
      var el = event.target
      if (!el || typeof el.closest !== 'function') return
      var hit = el.closest('#' + ROOT_ID + ' [data-dpd-action],#' + ROOT_ID + ' [data-dpd-close],#'
        + ROOT_ID + ' [data-dpd-refresh],#' + ROOT_ID + ' [data-dpd-next],#' + ROOT_ID + ' [data-dpd-pick],#'
        + ROOT_ID + ' [data-dpd-pre],#' + ROOT_ID + ' [data-dpd-showpre],#' + ROOT_ID + ' [data-dpd-showproblems]')
      if (!hit) return
      if (hit.hasAttribute('data-dpd-close')) { closeBanner(true); return }
      if (hit.hasAttribute('data-dpd-refresh')) { state.flash = null; refresh(true); return }
      if (hit.hasAttribute('data-dpd-next')) {
        var problems = (state.status && state.status.problems) || []
        if (problems.length > 1) {
          state.status.problems = problems.slice(1).concat(problems.slice(0, 1))
          render()
        }
        return
      }
      if (hit.hasAttribute('data-dpd-pick')) {
        var index = Number(hit.getAttribute('data-dpd-pick'))
        var list = (state.status && state.status.problems) || []
        var picked = list[index]
        if (picked) {
          state.status.problems = [picked].concat(list.filter(function (_, i) { return i !== index }))
          render()
        }
        return
      }
      if (hit.hasAttribute('data-dpd-showpre')) {
        state.showPre = true
        render()
        return
      }
      if (hit.hasAttribute('data-dpd-showproblems')) {
        state.showPre = false
        render()
        return
      }
      if (hit.hasAttribute('data-dpd-pre')) {
        var upcoming = (state.status && state.status.upcoming) || []
        var item = upcoming[Number(hit.getAttribute('data-dpd-pre'))]
        if (item) {
          // 把预警项提升成一个可操作的问题行，复用同一套键位与动作
          state.status.problems = [{
            name: item.name,
            version: item.version,
            severity: 'warn',
            title: '升级风险：' + (item.levelText || ''),
            detail: (item.reason || '') + (item.breaksAt ? '（dsh 升到 ' + item.breaksAt + ' 时它会失效）' : ''),
            actions: ['quarantine', 'uninstall', 'upgrade'],
            defaultAction: 'quarantine',
          }]
          state.status.upcoming = []
          // 提升完了要回到「问题视图」，否则 showPre=true 会把它自己藏起来
          state.showPre = false
          render()
        }
        return
      }
      var action = hit.getAttribute('data-dpd-action')
      if (action) startRepair(action, hit.getAttribute('data-dpd-target'))
    }

    //#endregion

    /**
     * 问题已经清零、只剩一次修复结果的横幅。
     * 存在的意义：验证「修复成功了」这件事，不能只靠横幅消失来暗示。
     */
    function renderResultOnly() {
      ensureStyle()
      state.bindings = {}
      var rows = []
      rows.push('<div class="dpd-head">')
      rows.push('<div class="dpd-title"><span class="dpd-badge">'
        + (state.flash.ok ? '修复完成' : '修复未完成') + '</span>'
        + esc(state.flash.text) + '</div>')
      rows.push('<button type="button" class="dpd-close" data-dpd-close="1" title="关闭">&times;</button>')
      rows.push('</div>')
      if (state.job && state.job.steps && state.job.steps.length > 0) {
        rows.push('<div class="dpd-log">')
        for (var i = 0; i < state.job.steps.length; i += 1) {
          rows.push('<div>· ' + esc(state.job.steps[i].label)
            + (state.job.steps[i].detail ? ' —— ' + esc(state.job.steps[i].detail) : '') + '</div>')
        }
        rows.push('</div>')
      }
      var el = root()
      if (el === null) {
        el = document.createElement('div')
        el.id = ROOT_ID
        el.setAttribute('role', 'status')
        document.body.appendChild(el)
      }
      el.className = state.flash.ok ? '' : 'dpd-warn'
      el.innerHTML = rows.join('')
    }

    function mount() {
      if (state.mounted) return
      state.mounted = true
      state.dismissed = readDismissed()
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('click', onClick, true)
      refresh(false)
      state.pollTimer = window.setInterval(function () {
        if (state.busy) return
        if (document.visibilityState === 'hidden') return
        refresh(false)
      }, POLL_MS)
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && !state.busy) refresh(false)
      })
    }

    function unmount() {
      state.mounted = false
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('click', onClick, true)
      if (state.pollTimer) window.clearInterval(state.pollTimer)
      if (state.jobTimer) window.clearTimeout(state.jobTimer)
      removeBanner()
    }

    function apply() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true })
        return
      }
      mount()
    }

    exports.apply = apply
    exports.inject = []
    exports.unmount = unmount
    // 给测试用的内部把手：不是插件协议的一部分，删掉也不影响运行
    exports.__test = {
      isTrustedRequest: undefined,
      fingerprint: fingerprint,
      isEditing: isEditing,
      state: state,
      mount: mount,
      unmount: unmount,
      onKeyDown: onKeyDown,
      refresh: refresh,
      startRepair: startRepair,
    }
    return module.exports
  },
})
