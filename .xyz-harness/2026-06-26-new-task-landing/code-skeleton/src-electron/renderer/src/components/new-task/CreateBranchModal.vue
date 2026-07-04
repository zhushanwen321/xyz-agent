<script setup lang="ts">
/**
 * CreateBranchModal.vue —— 步骤4b 创建分支 modal（#7，§4.4）。
 *
 * 数据流：openBranchModal 渲染 → 前端实时校验（git 分支名规则，AC-7.8）→
 * 提交 → useNewTaskFlow.submitCreateBranch（[内] 真接线 → gitApi.createBranch）。
 * - 非法名 → 按钮 disabled + 错误提示
 * - 飞行中 disabled 防重复（AC-7.9，由 composable branchCreateInFlight 守卫）
 * - 失败留 modal 显错可重试（D-7/AC-7.3）；分支名双重校验：前端 + runtime（T6.8）
 */
import { ref, computed } from 'vue'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'

const { submitCreateBranch } = useNewTaskFlow()

const branchName = ref('')
/** 前端校验（AC-7.8）：非空 + git 分支名规则（禁空格/..特殊字符）。runtime 二次校验在 GitService（T6.8）。 */
const isValid = computed(() => /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branchName.value.trim()))

function onSubmit(): void {
  if (!isValid.value) return
  // [内] 真接线 gitApi.createBranch（经 composable）；失败留 modal 由 composable 不转换状态（D-7）
  void submitCreateBranch(branchName.value.trim())
}
</script>

<template>
  <!-- 骨架占位：表单 + 校验提示 + 提交按钮属⑥Wave -->
  <div class="create-branch-modal">
    <input v-model="branchName" />
    <button :disabled="!isValid" @click="onSubmit">创建并切换</button>
  </div>
</template>
