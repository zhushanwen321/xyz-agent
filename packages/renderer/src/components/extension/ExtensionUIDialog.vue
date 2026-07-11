<script setup lang="ts">
/**
 * ExtensionUIDialog——渲染 pi extension 的交互请求（confirm/select/input/editor）。
 *
 * pi extension 调 ctx.ui.select/confirm/input → runtime 推 extension.ui_request
 * → useExtensionUI 维护队列 → 此组件渲染队首请求的对话框
 * → 用户操作 → respond() 回传（带 method）→ pi Promise resolve。
 *
 * 按 method 路由：
 * - confirm → ConfirmDialog（是/否）
 * - select → Select 下拉选择
 * - input → Input 文本输入
 * - editor → Textarea 多行编辑
 *
 * notify 不走此组件——它是 fire-and-forget（pi 不等回复），经 extension.notify WS 帧
 * → useExtensionNotify → useToast 渲染为非阻塞 toast。
 */
import { ref, computed, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useExtensionUI } from '@/composables/useExtensionUI'
import { useSidebar } from '@/composables/features/useSidebar'

const { focusedSessionId } = useSidebar()
const { currentRequest, respond, cancel } = useExtensionUI(focusedSessionId)

const req = computed(() => currentRequest.value[0])
const isOpen = computed(() => req.value !== undefined)

// ── select/input 状态 ──
const inputValue = ref('')
const selectValue = ref('')

// 新请求到来时，重置输入状态
watch(req, (r) => {
  if (!r) return
  inputValue.value = r.default ?? r.prefill ?? ''
  selectValue.value = r.default ?? ''
})

function onConfirm(): void {
  const r = req.value
  if (!r) return
  if (r.method === 'input' || r.method === 'editor') {
    respond(inputValue.value)
  } else if (r.method === 'select') {
    respond(selectValue.value)
  } else {
    respond(true)
  }
}
</script>

<template>
  <Dialog :open="isOpen" @update:open="(v: boolean) => { if (!v) cancel() }">
    <DialogContent hide-close class="max-w-[420px]" data-testid="extension-ui-dialog">
      <DialogHeader>
        <DialogTitle>{{ req?.title || 'Extension 请求' }}</DialogTitle>
        <DialogDescription v-if="req?.message">{{ req.message }}</DialogDescription>
      </DialogHeader>

      <!-- confirm -->
      <div v-if="req?.method === 'confirm'" class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" @click="cancel">取消</Button>
        <Button variant="default" @click="onConfirm">确认</Button>
      </div>

      <!-- select -->
      <div v-else-if="req?.method === 'select'" class="flex flex-col gap-3 pt-2">
        <Select v-model="selectValue">
          <SelectTrigger data-testid="extension-ui-select">
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="opt in req.options"
              :key="opt"
              :value="opt"
            >
              {{ opt }}
            </SelectItem>
          </SelectContent>
        </Select>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="cancel">取消</Button>
          <Button variant="default" :disabled="!selectValue" @click="onConfirm">确认</Button>
        </div>
      </div>

      <!-- input / editor -->
      <div v-else-if="req?.method === 'input' || req?.method === 'editor'" class="flex flex-col gap-3 pt-2">
        <Textarea
          v-if="req.method === 'editor'"
          v-model="inputValue"
          rows="8"
          data-testid="extension-ui-textarea"
          class="font-mono text-[12px]"
        />
        <Input
          v-else
          v-model="inputValue"
          data-testid="extension-ui-input"
        />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="cancel">取消</Button>
          <Button variant="default" @click="onConfirm">确认</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
