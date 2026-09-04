<template>
  <!--
    引擎 claude（Claude Code）单色 icon（U3 D8 / C-ext-18）。几何来自 assets/icons/engine/claude.svg
    （源 lobehub icons claudecode.svg，path d 原样拷贝；眼部镂空依赖 evenodd 填充规则；
    引擎 id 对齐 runtime ProviderSource 'claude'），禁止手改 path d——改几何回源 SVG 文件同步。
    viewBox 扩边留白：内容 24 单位居中、占比 60%（对齐 pi 官方留白观感），
    视觉尺寸由调用方 class 控制（size-*）。
  -->
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 40 40" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/>
  </svg>
</template>
