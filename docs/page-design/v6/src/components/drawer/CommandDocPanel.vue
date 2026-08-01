<script setup lang="ts">
/**
 * CommandDocPanel · doc tab（命令/skill 文档展示）
 * header（命令名 + Skill source 标签，bg-surface-2 浮起去 border-b）
 * + desc + doc 正文（markdown 占位 + 参数 + 代码块 bg-input）
 * + meta（SKILL.md 路径，mt-4 空白分层去 border-t）
 */
</script>

<template>
  <div class="cd-v6">
    <!-- header：bg-surface-2 浮起，去 border-b -->
    <div class="cd-header">
      <svg class="cd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <span class="cd-name">/build</span>
      <span class="cd-source">Skill</span>
    </div>

    <!-- 文档体 -->
    <div class="cd-body">
      <p class="cd-desc">运行项目构建命令并报告结果。</p>

      <div class="cd-doc">
        <div class="cd-h2">用法</div>
        <p class="cd-p">
          在 composer 中输入 <span class="cd-inline-code">/build</span> 触发，或在对话流中由 agent 自动调用。
        </p>

        <div class="cd-h2">参数</div>
        <div class="cd-li">无参数：执行默认构建脚本</div>
        <div class="cd-li">
          带 <span class="cd-inline-code">--watch</span>：监听模式
        </div>

        <div class="cd-code">
          <span class="cd-code-com"># 默认构建</span><br />
          <span class="cd-code-kw">pnpm</span> build<br />
          <span class="cd-code-com"># 监听模式</span><br />
          <span class="cd-code-kw">pnpm</span> build <span class="cd-code-str">--watch</span>
        </div>

        <div class="cd-h2">行为</div>
        <p class="cd-p">
          执行 <span class="cd-inline-code">package.json</span> 的 build 脚本，输出走 terminal tab，失败在对话流 tool 块回显。
        </p>
      </div>

      <!-- 元信息区：mt-4 空白分层，去 border-t -->
      <div class="cd-meta">
        <p class="cd-meta-label">SKILL.md 路径</p>
        <p class="cd-meta-val">~/.agents/skills/build/SKILL.md</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd-v6 {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-height: 0;
  overflow: hidden;
}

/* header：bg-surface-2 浮起，去 border-b */
.cd-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface-2);
  flex-shrink: 0;
}
.cd-header .cd-ico {
  width: 14px;
  height: 14px;
  color: var(--reasoning);
  flex-shrink: 0;
}
.cd-header .cd-name {
  font-family: var(--font-mono);
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--neutral-fg);
}
/* source 标签：纯色文字 + 圆角 6px，去 bg 去 border */
.cd-source {
  margin-left: auto;
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
}

.cd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
}
.cd-desc {
  font-size: var(--text-md);
  color: var(--neutral-mid);
  margin-bottom: 12px;
  line-height: 1.6;
}
.cd-doc {
  font-size: var(--text-base);
  color: var(--neutral-fg);
  line-height: 1.65;
}
.cd-doc .cd-h2 {
  font-size: 15px;
  font-weight: 600;
  color: var(--neutral-fg);
  margin: 14px 0 6px;
}
.cd-doc .cd-p {
  margin-bottom: 8px;
  color: var(--neutral-mid);
}
.cd-doc .cd-code {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  color: var(--neutral-fg);
  margin-bottom: 10px;
  line-height: 1.6;
  overflow-x: auto;
}
.cd-doc .cd-code .cd-code-kw {
  color: var(--accent);
}
.cd-doc .cd-code .cd-code-str {
  color: var(--success);
}
.cd-doc .cd-code .cd-code-com {
  color: var(--neutral-dim);
}
.cd-doc .cd-inline-code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
  color: var(--neutral-fg);
}
.cd-doc .cd-li {
  margin-bottom: 4px;
  color: var(--neutral-mid);
  padding-left: 14px;
  position: relative;
}
.cd-doc .cd-li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 9px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--neutral-dim);
}

/* 元信息区：mt-4 空白分层 */
.cd-meta {
  margin-top: 16px;
}
.cd-meta .cd-meta-label {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.cd-meta .cd-meta-val {
  margin-top: 2px;
  word-break: break-all;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
</style>
