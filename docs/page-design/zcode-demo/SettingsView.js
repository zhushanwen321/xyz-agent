export default {
  template: `
    <div class="flex h-full">
      <div class="w-[220px] flex-shrink-0 border-r border-white/[0.06] p-3 thin-scroll overflow-y-auto">
        <div class="flex items-center gap-2 text-text-secondary text-xs px-2.5 py-2 cursor-pointer hover:text-text-primary mb-4">
          <span>←</span> 返回工作区
        </div>
        <div class="space-y-0.5">
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">⚙ 常规</div>
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">⌥ 代码预览</div>
          <div class="px-2.5 py-2 rounded-lg bg-white/[0.07] text-text-primary text-[13px] cursor-pointer flex items-center gap-2">◈ 模型设置</div>
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">◇ 技能</div>
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">⛭ MCP 服务器</div>
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">▣ 插件管理</div>
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">❯ 命令</div>
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">▤ 索引库</div>
          <div class="px-2.5 py-2 rounded-lg text-text-secondary text-[13px] hover:bg-white/[0.04] cursor-pointer flex items-center gap-2">⊞ 使用统计</div>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto thin-scroll px-8 py-6">
        <h1 class="text-2xl font-semibold text-text-primary mb-2">模型设置</h1>
        <p class="text-sm text-text-secondary mb-6">管理自定义模型供应商，配置后可在聊天时选择使用。</p>

        <div class="bg-base border border-white/[0.06] rounded-xl p-5 mb-6">
          <div class="flex items-center justify-between mb-5">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm">B</div>
              <div>
                <div class="flex items-center gap-2">
                  <span class="font-medium text-text-primary">BigModel</span>
                  <span class="px-1.5 py-0.5 rounded text-[11px] bg-success/15 text-success border border-success/20">已启用</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2 text-xs text-text-secondary">
              <span>连接方式</span>
              <span class="bg-panel border border-white/[0.06] rounded px-2 py-1">编程套餐 ▾</span>
            </div>
          </div>

          <div class="bg-panel border border-white/[0.06] rounded-lg p-4 mb-5">
            <div class="flex items-center justify-between mb-4">
              <div>
                <div class="text-sm font-medium text-text-primary">GLM Coding Pro <span class="text-[11px] text-accent border border-accent/30 rounded px-1.5 py-0.5 ml-2">150% 配额</span></div>
                <div class="text-xs text-text-secondary mt-1">到期 2027年1月11日 · 管理 · 解绑</div>
              </div>
              <button class="px-3 py-1.5 rounded-lg bg-panel-hover border border-white/[0.06] text-xs text-text-primary hover:bg-white/[0.07]">升级</button>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <div class="text-xs text-text-secondary mb-1">5 小时剩余</div>
                <div class="text-lg font-semibold text-text-primary">42% <span class="text-xs font-normal text-text-secondary">20:27</span></div>
                <div class="h-1.5 bg-base rounded-full mt-2 overflow-hidden">
                  <div class="h-full bg-accent rounded-full" style="width:42%"></div>
                </div>
              </div>
              <div>
                <div class="text-xs text-text-secondary mb-1">MCP 额度</div>
                <div class="text-lg font-semibold text-text-primary">94% <span class="text-xs font-normal text-text-secondary">7月11日</span></div>
                <div class="h-1.5 bg-base rounded-full mt-2 overflow-hidden">
                  <div class="h-full bg-accent rounded-full" style="width:94%"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="text-xs text-text-secondary mb-3">模型列表</div>
          <div class="space-y-2">
            <div class="flex items-center justify-between px-3 py-2.5 bg-panel border border-white/[0.06] rounded-lg">
              <span class="text-sm text-text-primary">GLM-5.2</span>
              <span class="text-xs text-text-secondary bg-base px-2 py-0.5 rounded">100万</span>
            </div>
            <div class="flex items-center justify-between px-3 py-2.5 bg-panel border border-white/[0.06] rounded-lg">
              <span class="text-sm text-text-primary">GLM-5-Turbo</span>
              <span class="text-xs text-text-secondary bg-base px-2 py-0.5 rounded">20万</span>
            </div>
          </div>
        </div>
      </div>
    </div>`
}
