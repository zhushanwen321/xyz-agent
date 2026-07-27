<!--
  W1T3 占位组件（cw wave w1 / DM1）。

  用途：最小可运行 mount，验证 virtua/vue 的导入链路（Virtualizer 组件 + VirtualizerHandle
  类型）在 vue3 + ts strict 下能正确解析、能 ref 到 handle。为 w2 真正的 MessageStreamVirtua
  组件铺路——w1 阶段先确认「导入 + mount + ref」这条最短路径通。

  约束：
  - 放 __tests__/ 子目录，明确标记为临时产物，不被任何业务路径引用
    （Panel.vue / PaneSessionView.vue / 路由配置零命中——见 W1T6 grep 验证）
  - w2 起会迁出本目录或删除
-->
<script setup lang="ts">
import { ref } from 'vue'
import { Virtualizer, type VirtualizerHandle } from 'virtua/vue'

const VIEWPORT_HEIGHT_PX = 400
const ITEM_HEIGHT_PX = 100
const SAMPLE_ITEM_COUNT = 5

const vlistRef = ref<VirtualizerHandle | null>(null)
const data = ref<number[]>(Array.from({ length: SAMPLE_ITEM_COUNT }, (_, i) => i))
</script>

<template>
  <Virtualizer
    ref="vlistRef"
    :data="data"
    :style="{ height: `${VIEWPORT_HEIGHT_PX}px` }"
  >
    <template #default="{ item }">
      <div :style="{ height: `${ITEM_HEIGHT_PX}px` }">{{ item }}</div>
    </template>
  </Virtualizer>
</template>
