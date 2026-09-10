/* ─────────────────────────────────────────────────────────────────────────────
   coding-plan 额度查询配置交互 demo · 共享逻辑
   仅供原型演示：齐备性判定 / 结果渲染 / 场景控制。与生产代码无关。
   ───────────────────────────────────────────────────────────────────────────── */
window.Q = (function () {
  const PRESETS = {
    'zhipu': {
      label: '智谱 GLM Coding Plan', auth: ['api-key'], needsWorkspace: false,
      help: '在 bigmodel.cn 控制台 → API Keys 页面获取',
    },
    'kimi-coding': {
      label: 'Kimi Coding Plan', auth: ['api-key', 'oauth'], needsWorkspace: false,
      help: '在 Kimi 开放平台 → API Key 管理页面获取',
    },
    'minimax': {
      label: 'MiniMax Coding Plan', auth: ['api-key'], needsWorkspace: false,
      help: '在 MiniMax 开放平台 → 账户管理获取',
    },
    'mimo': {
      label: '小米 MiMo Coding Plan', auth: ['cookie'], needsWorkspace: false,
      help: '登录 platform.xiaomimimo.com 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
    },
    'opencode-go': {
      label: 'opencode.go', auth: ['cookie'], needsWorkspace: true,
      help: '登录 opencode.ai 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
    },
  }

  /** 失败原因文案（no-credential 为本次新增） */
  const REASON_TEXT = {
    'no-credential': '额度查询失败：未找到可用凭证。请在上方「凭据」区填写 API Key，或在此填写专属 API Key',
    'unauthorized': '额度查询失败：凭证可能过期。与该供应商发起一次对话触发凭证刷新后，点击刷新重试',
    'network': '额度查询失败：网络异常或服务不可用，请检查网络连接后重试',
    'no-subscription': '额度查询失败：未检测到有效订阅或 Cookie 已失效，请检查订阅状态或更新 Cookie',
    'parse': '额度查询失败：额度响应解析失败，请稍后重试；若持续出现请更新应用',
    'not_configured': '额度查询失败：未配置 Workspace。打开 opencode.ai 控制台复制 workspace 页 URL，填入上方「Workspace 地址」后重试',
  }

  /** 各类型的示例额度（窗口能力与真实 fetcher 一致：智谱仅 5h / MiMo 仅本月 / opencode 三窗口） */
  const SAMPLE = {
    'zhipu': [{ pct: 32, used: 1600, limit: 5000, reset: '2h18m' }, null, null],
    'kimi-coding': [{ pct: 24, used: 1204, limit: 5000, reset: '2h30m' }, { pct: 41, used: 4100, limit: 10000, reset: '3d12h' }, null],
    'minimax': [{ pct: 18, used: 900, limit: 5000, reset: '1h02m' }, { pct: 7, used: 700, limit: 10000, reset: '5d' }, null],
    'mimo': [null, null, { pct: 63, used: 6300, limit: 10000, reset: '12d' }],
    'opencode-go': [{ pct: 12, used: null, limit: null, reset: '3h10m' }, { pct: 55, used: null, limit: null, reset: '2d4h' }, { pct: 88, used: null, limit: null, reset: '9d' }],
  }

  const isCookie = (t) => !!t && PRESETS[t].auth.includes('cookie')
  const supportsOauth = (t) => !!t && PRESETS[t].auth.includes('oauth')
  const needsWorkspace = (t) => !!t && PRESETS[t].needsWorkspace

  /**
   * 齐备性判定 —— 不含「凭证来源」维度的**并集版**，服务方案 A/C/D（它们没有凭证来源分段控件）。
   *
   * 方案 B 的 source 感知版实现在 demo-b.html 内联的 readiness()。
   * 两者的 SSOT 是设计文档 `coding-plan-quota-config-ux.md` §7.2 —— 原型用于对照交互形态，
   * 不是判定的权威；差异点已在文档附录 B 登记。
   *
   * 两条共同规则（v2）：
   * 1) 判定取「草稿 ∨ 已保存」并集；
   * 2) **凭证归属**：已保存的凭证只在「已保存类型 === 当前类型」时才算数（切换类型即作废）。
   */
  function readiness(s) {
    if (!s.fetcher) return { ready: false, missing: ['查询类型'] }
    const p = PRESETS[s.fetcher]
    const typeChanged = s.saved.fetcher !== s.fetcher
    const missing = []
    if (p.auth.includes('cookie')) {
      if (!s.cookieDraft.trim() && !(s.saved.cookie && !typeChanged)) missing.push('Cookie')
    } else {
      const hasExclusive = !!s.apiKeyDraft.trim() || (s.saved.apiKey && !typeChanged)
      const hasProvider = s.provider.hasApiKey || (p.auth.includes('oauth') && s.provider.hasOauth)
      if (!hasExclusive && !hasProvider) missing.push('API Key')
    }
    // workspace 是明文、始终回显 → 判定只看草稿（D13：屏幕即真相）；
    // cookie/apiKey 是密文、不回显 → 判定取「草稿 ∨ 已保存」并集
    if (p.needsWorkspace && !s.workspaceDraft.trim()) missing.push('Workspace 地址')
    return { ready: missing.length === 0, missing }
  }

  /** 缺什么 —— 置灰必须配一句「怎么变亮」 */
  function missingText(missing) {
    if (!missing.length) return ''
    return '还缺：' + missing.join('、')
  }

  /** 额度行渲染（pct=null 表示该窗口无限制/未订阅，仍占一行显示 ∞） */
  function quotaBlock(fetcher, opts) {
    opts = opts || {}
    const rows = SAMPLE[fetcher] || SAMPLE['zhipu']
    const labels = ['5h', '本周', '本月']
    const muted = opts.muted ? ' muted' : ''
    const body = rows.map(function (w, i) {
      if (!w || w.pct == null) {
        return '<div class="qrow' + muted + '"><span class="qlab">' + labels[i] + '</span>'
          + '<span class="qtrack"></span><span class="qpct">∞</span><span class="qreset">--</span></div>'
      }
      const tone = w.pct >= 90 ? ' danger' : (w.pct >= 70 ? ' warn' : '')
      const amt = w.used != null ? ' title="已用 ' + w.used + ' / ' + w.limit + '"' : ''
      return '<div class="qrow' + muted + '"><span class="qlab">' + labels[i] + '</span>'
        + '<span class="qtrack"><span class="qfill' + tone + '" style="width:' + w.pct + '%"></span></span>'
        + '<span class="qpct"' + amt + '>' + w.pct + '%</span>'
        + '<span class="qreset">' + w.reset + '</span></div>'
    }).join('')
    return '<div class="quota-box">' + body + '</div>'
  }

  /** 模拟一次测试查询（demo 用，700ms 后按 scenario 返回） */
  function simulateTest(state) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        const want = state.simulateResult
        if (want === 'success') resolve({ ok: true })
        else resolve({ ok: false, reason: want })
      }, 700)
    })
  }

  /** 场景控制条：模拟 provider 侧的真实状态差异 */
  function scenarioBar(state, onChange) {
    function seg(name, options, current) {
      return '<div class="seg" data-seg="' + name + '">' + options.map(function (o) {
        return '<button type="button" data-val="' + o.val + '" aria-pressed="'
          + (o.val === current) + '">' + o.label + '</button>'
      }).join('') + '</div>'
    }
    return ''
      + '<div class="field"><span class="field-label">模拟 · Provider「凭据」区状态</span>'
      + seg('cred', [
        { val: 'apikey', label: '已填 API Key' },
        { val: 'none', label: '未填凭据' },
      ], state.provider.credential) + '</div>'
      + '<div class="field"><span class="field-label">模拟 · 测试查询返回</span>'
      + seg('sim', [
        { val: 'success', label: '成功' },
        { val: 'no-credential', label: '缺凭证' },
        { val: 'unauthorized', label: '凭证过期' },
        { val: 'network', label: '网络异常' },
      ], state.simulateResult) + '</div>'
  }

  function bindScenario(root, state, onChange, rerender) {
    root.querySelectorAll('[data-seg]').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-val]')
        if (!btn) return
        const val = btn.dataset.val
        if (seg.dataset.seg === 'cred') {
          state.provider.credential = val
          state.provider.hasApiKey = val === 'apikey'
          state.provider.hasOauth = false
        } else {
          state.simulateResult = val
        }
        onChange && onChange()
        rerender()
      })
    })
  }

  const REASONS = Object.keys(REASON_TEXT)

  return {
    PRESETS: PRESETS,
    REASON_TEXT: REASON_TEXT,
    REASONS: REASONS,
    isCookie: isCookie,
    supportsOauth: supportsOauth,
    needsWorkspace: needsWorkspace,
    readiness: readiness,
    missingText: missingText,
    quotaBlock: quotaBlock,
    simulateTest: simulateTest,
    scenarioBar: scenarioBar,
    bindScenario: bindScenario,
    /** 新建一份初始状态：默认 provider 已配好 API Key，用户从「未选类型」开始 */
    initialState: function () {
      return {
        fetcher: null,
        enabled: false,
        credentialSource: 'provider',
        apiKeyDraft: '',
        cookieDraft: '',
        workspaceDraft: '',
        // saved.fetcher = 已落盘的类型（null = 从未保存过），它是「凭证归属」的锚点（D5）
        saved: { fetcher: null, apiKey: false, cookie: false, workspace: false },
        provider: { credential: 'apikey', hasApiKey: true, hasOauth: false },
        testing: false,
        testResult: null,
        simulateResult: 'success',
        dirty: false,
      }
    },
  }
})()
