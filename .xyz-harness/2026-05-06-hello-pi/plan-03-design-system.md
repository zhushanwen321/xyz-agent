# Task 3: Design System 组件库

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 12 个基础 UI 组件 + 工具函数，全部使用 design tokens，零硬编码颜色。

**依赖:** Task 2 完成（tokens、ThemeProvider、i18n 已就绪）

**产出目录:** `src/design-system/`

**Tech:** Radix Vue (reka-ui) + Tailwind CSS v4 + class-variance-authority + clsx + tailwind-merge

**Commit 策略:** 分 4 个 Batch，每 Batch 3 个组件 + 相关文件，逐步构建。

---

## 文件结构

```
src/design-system/
├── utils.ts                     # cn() 工具函数
├── components/
│   ├── Button.vue               # Batch 1
│   ├── Input.vue                # Batch 1
│   ├── Textarea.vue             # Batch 1
│   ├── Select.vue               # Batch 2
│   ├── ScrollArea.vue           # Batch 2
│   ├── Tooltip.vue              # Batch 2
│   ├── Dropdown.vue             # Batch 3
│   ├── Dialog.vue               # Batch 3
│   ├── Tabs.vue                 # Batch 3
│   ├── Badge.vue                # Batch 4
│   ├── Toggle.vue               # Batch 4
│   ├── ProgressBar.vue          # Batch 4
└── index.ts                     # 统一导出
```

---

## 约定

所有组件必须遵守：

1. **Design tokens only** — 颜色用 `bg-primary`、`text-foreground`、`border` 等 token class，禁止 `#hex`、`rgb()`、`oklch()` 硬编码
2. **Dark theme** — 通过 Tailwind `dark:` 变体 + ThemeProvider 自动生效
3. **TypeScript props** — `defineProps<T>()` 完整类型，withDefaults 提供默认值
4. **aria-* 无障碍** — 通过 Radix Vue 原语自动获得；自定义元素需手动添加
5. **i18n** — 用户可见文本通过 `useI18n()` 的 `t()` 函数
6. **data-slot** — 每个根元素加 `data-slot="component-name"` 用于 CSS 选择器
7. **class 合并** — 通过 `cn()` 合并外部传入的 `class` prop
8. **ESLint** — 组件内禁止使用原生 `<button>/<input>/<select>/<textarea>`（使用 Radix Vue 原语替代）；如必须使用，加 `<!-- eslint-disable-next-line taste/no-native-form-elements -->`

---

## Batch 1: 基础表单组件

**Commit:** `feat(p1): design-system — Button, Input, Textarea, utils`

### Step 0: 创建 utils.ts

- [ ] 创建 `src/design-system/utils.ts`

```typescript
// src/design-system/utils.ts
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### Step 1: 创建 Button.vue

- [ ] 创建 `src/design-system/components/Button.vue`

variant: `primary` / `ghost` / `danger`
size: `sm` / `md` / `lg`
使用 `cva()` 生成 variant 样式

```vue
<!-- src/design-system/components/Button.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "./button-variants"
import { Primitive } from "reka-ui"
import type { PrimitiveProps } from "reka-ui"
import { cn } from "../utils"
import { buttonVariants } from "./button-variants"

interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"]
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
  variant: "primary",
  size: "md",
})
</script>

<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
```

- [ ] 创建 `src/design-system/components/button-variants.ts`

```typescript
// src/design-system/components/button-variants.ts
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        danger:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30",
      },
      size: {
        sm: "h-8 rounded-md px-3 text-xs",
        md: "h-9 px-4 py-2 text-sm",
        lg: "h-10 rounded-md px-6 text-base",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>
```

### Step 2: 创建 Input.vue

- [ ] 创建 `src/design-system/components/Input.vue`

单行输入框，支持 error / disabled 状态。
使用 Radix Vue 无原生 input 原语，此处加 eslint-disable 注释。

```vue
<!-- src/design-system/components/Input.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { cn } from "../utils"

const props = withDefaults(defineProps<{
  modelValue?: string
  defaultValue?: string
  placeholder?: string
  disabled?: boolean
  error?: boolean
  class?: HTMLAttributes["class"]
}>(), {
  modelValue: undefined,
  defaultValue: "",
  placeholder: "",
  disabled: false,
  error: false,
})

const emits = defineEmits<{
  "update:modelValue": [value: string]
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})

const { t } = useI18n()
</script>

<template>
  <!-- eslint-disable-next-line taste/no-native-form-elements -->
  <input
    v-model="modelValue"
    data-slot="input"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-invalid="error"
    :aria-label="error ? t('common.inputError') : undefined"
    :class="cn(
      'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors',
      'placeholder:text-muted-foreground',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
      props.class,
    )"
  >
</template>
```

### Step 3: 创建 Textarea.vue

- [ ] 创建 `src/design-system/components/Textarea.vue`

多行输入框，支持 `autoResize` 自动调整高度（默认最大 140px）。

```vue
<!-- src/design-system/components/Textarea.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "../utils"

const props = withDefaults(defineProps<{
  modelValue?: string
  defaultValue?: string
  placeholder?: string
  disabled?: boolean
  autoResize?: boolean
  maxHeight?: number
  class?: HTMLAttributes["class"]
}>(), {
  modelValue: undefined,
  defaultValue: "",
  placeholder: "",
  disabled: false,
  autoResize: false,
  maxHeight: 140,
})

const emits = defineEmits<{
  "update:modelValue": [value: string]
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})

const textarea = ref<HTMLTextAreaElement>()

function onInput() {
  if (!props.autoResize || !textarea.value) return
  textarea.value.style.height = "auto"
  const scrollHeight = textarea.value.scrollHeight
  const maxH = props.maxHeight
  textarea.value.style.height = `${Math.min(scrollHeight, maxH)}px`
  textarea.value.style.overflow = scrollHeight > maxH ? "auto" : "hidden"
}

onMounted(() => {
  if (props.autoResize && textarea.value) {
    onInput()
  }
})
</script>

<template>
  <!-- eslint-disable-next-line taste/no-native-form-elements -->
  <textarea
    ref="textarea"
    v-model="modelValue"
    data-slot="textarea"
    :placeholder="placeholder"
    :disabled="disabled"
    :style="autoResize ? { maxHeight: `${maxHeight}px`, overflow: 'hidden' } : undefined"
    :class="cn(
      'flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors',
      'placeholder:text-muted-foreground',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'disabled:cursor-not-allowed disabled:opacity-50',
      autoResize && 'resize-none',
      props.class,
    )"
    @input="onInput"
  />
</template>
```

### Step 4: Batch 1 验证

- [ ] 确认 `Button.vue` 可渲染 primary/ghost/danger 三种变体，sm/md/lg 三种尺寸
- [ ] 确认 `Input.vue` error 状态显示红色边框，disabled 状态灰显
- [ ] 确认 `Textarea.vue` autoResize 在输入时自动增高，到 maxHeight 停止
- [ ] 确认所有组件 `class` prop 可通过 `cn()` 合并
- [ ] 提交：`feat(p1): design-system — Button, Input, Textarea, utils`

---

## Batch 2: Radix Vue 原语组件（一）

**Commit:** `feat(p1): design-system — Select, ScrollArea, Tooltip`

### Step 5: 创建 Select.vue

- [ ] 创建 `src/design-system/components/Select.vue`

基于 Radix Vue `SelectRoot`，封装 Trigger + Content + Item 子组件。

```vue
<!-- src/design-system/components/Select.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectLabel,
  SelectPortal,
  SelectRoot,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui"
import { Check, ChevronDown, ChevronUp } from "lucide-vue-next"
import { cn } from "../utils"

export interface SelectOption {
  label: string
  value: string
  disabled?: boolean
}

export interface SelectGroup {
  label?: string
  options: SelectOption[]
}

const props = withDefaults(defineProps<{
  modelValue?: string
  defaultValue?: string
  placeholder?: string
  disabled?: boolean
  groups?: SelectGroup[]
  class?: HTMLAttributes["class"]
}>(), {
  modelValue: undefined,
  placeholder: "Select...",
  disabled: false,
  groups: () => [],
})

const emits = defineEmits<{
  "update:modelValue": [value: string]
}>()
</script>

<template>
  <SelectRoot
    data-slot="select"
    :model-value="modelValue"
    :default-value="defaultValue"
    :disabled="disabled"
    @update:model-value="emits('update:modelValue', $event)"
  >
    <SelectTrigger
      :class="cn(
        'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors',
        'placeholder:text-muted-foreground',
        'focus:outline-none focus:ring-2 focus:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )"
    >
      <SelectValue :placeholder="placeholder" />
      <ChevronDown class="size-4 opacity-50" />
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        :class="cn(
          'relative z-50 max-h-72 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        )"
      >
        <SelectScrollUpButton class="flex cursor-default items-center justify-center py-1">
          <ChevronUp class="size-4" />
        </SelectScrollUpButton>
        <SelectViewport class="p-1">
          <template v-for="(group, gi) in groups" :key="gi">
            <SelectGroup v-if="group.label">
              <SelectLabel class="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                {{ group.label }}
              </SelectLabel>
              <SelectItem
                v-for="option in group.options"
                :key="option.value"
                :value="option.value"
                :disabled="option.disabled"
                class="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span class="absolute left-2 flex size-3.5 items-center justify-center">
                  <SelectItemIndicator>
                    <Check class="size-4" />
                  </SelectItemIndicator>
                </span>
                <SelectItemText>{{ option.label }}</SelectItemText>
              </SelectItem>
            </SelectGroup>
            <template v-else>
              <SelectItem
                v-for="option in group.options"
                :key="option.value"
                :value="option.value"
                :disabled="option.disabled"
                class="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <span class="absolute left-2 flex size-3.5 items-center justify-center">
                  <SelectItemIndicator>
                    <Check class="size-4" />
                  </SelectItemIndicator>
                </span>
                <SelectItemText>{{ option.label }}</SelectItemText>
              </SelectItem>
            </template>
            <SelectSeparator v-if="gi < groups.length - 1" class="-mx-1 my-1 h-px bg-muted" />
          </template>
          <slot />
        </SelectViewport>
        <SelectScrollDownButton class="flex cursor-default items-center justify-center py-1">
          <ChevronDown class="size-4" />
        </SelectScrollDownButton>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
```

### Step 6: 创建 ScrollArea.vue

- [ ] 创建 `src/design-system/components/ScrollArea.vue`

基于 Radix Vue `ScrollAreaRoot`，自定义滚动条样式。

```vue
<!-- src/design-system/components/ScrollArea.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "reka-ui"
import { cn } from "../utils"

const props = withDefaults(defineProps<{
  class?: HTMLAttributes["class"]
  orientation?: "vertical" | "horizontal" | "both"
}>(), {
  orientation: "vertical",
})
</script>

<template>
  <ScrollAreaRoot
    data-slot="scroll-area"
    :class="cn('relative overflow-hidden', props.class)"
  >
    <ScrollAreaViewport class="h-full w-full rounded-[inherit]">
      <slot />
    </ScrollAreaViewport>
    <ScrollAreaScrollbar
      :orientation="orientation"
      :class="cn(
        'flex touch-none select-none p-px',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        'transition-colors',
      )"
    >
      <ScrollAreaThumb class="relative flex-1 rounded-full bg-border" />
    </ScrollAreaScrollbar>
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
```

### Step 7: 创建 Tooltip.vue

- [ ] 创建 `src/design-system/components/Tooltip.vue`

基于 Radix Vue `TooltipRoot`，hover 触发，支持延迟。

```vue
<!-- src/design-system/components/Tooltip.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import {
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "reka-ui"
import { cn } from "../utils"

const props = withDefaults(defineProps<{
  content: string
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  delayDuration?: number
  class?: HTMLAttributes["class"]
}>(), {
  side: "top",
  sideOffset: 4,
  delayDuration: 300,
})
</script>

<template>
  <TooltipProvider :delay-duration="delayDuration">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          data-slot="tooltip"
          :side="side"
          :side-offset="sideOffset"
          :class="cn(
            'z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95',
            props.class,
          )"
        >
          {{ content }}
          <TooltipArrow class="fill-primary" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
```

### Step 8: Batch 2 验证

- [ ] 确认 `Select.vue` 可选择选项，分组显示，disabled 项不可选
- [ ] 确认 `ScrollArea.vue` 自定义滚动条样式，支持 vertical/horizontal/both
- [ ] 确认 `Tooltip.vue` hover 后延迟显示，点击外部自动关闭
- [ ] 提交：`feat(p1): design-system — Select, ScrollArea, Tooltip`

---

## Batch 3: Radix Vue 原语组件（二）

**Commit:** `feat(p1): design-system — Dropdown, Dialog, Tabs`

### Step 9: 创建 Dropdown.vue

- [ ] 创建 `src/design-system/components/Dropdown.vue`

基于 Radix Vue `DropdownMenuRoot`，支持 click 触发、分组、分隔线。

```vue
<!-- src/design-system/components/Dropdown.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui"
import { cn } from "../utils"

export interface DropdownItem {
  label: string
  value: string
  disabled?: boolean
  destructive?: boolean
}

export interface DropdownGroup {
  label?: string
  items: DropdownItem[]
}

const props = withDefaults(defineProps<{
  groups?: DropdownGroup[]
  align?: "start" | "center" | "end"
  sideOffset?: number
  class?: HTMLAttributes["class"]
}>(), {
  groups: () => [],
  align: "start",
  sideOffset: 4,
})

const emits = defineEmits<{
  select: [value: string]
}>()
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        data-slot="dropdown"
        :align="align"
        :side-offset="sideOffset"
        :class="cn(
          'z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          props.class,
        )"
      >
        <template v-for="(group, gi) in groups" :key="gi">
          <DropdownMenuGroup v-if="group.label">
            <DropdownMenuLabel class="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              {{ group.label }}
            </DropdownMenuLabel>
            <DropdownMenuItem
              v-for="item in group.items"
              :key="item.value"
              :disabled="item.disabled"
              :class="cn(
                'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
                'focus:bg-accent focus:text-accent-foreground',
                'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                item.destructive && 'text-destructive focus:text-destructive',
              )"
              @select="emits('select', item.value)"
            >
              {{ item.label }}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <template v-else>
            <DropdownMenuItem
              v-for="item in group.items"
              :key="item.value"
              :disabled="item.disabled"
              :class="cn(
                'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
                'focus:bg-accent focus:text-accent-foreground',
                'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                item.destructive && 'text-destructive focus:text-destructive',
              )"
              @select="emits('select', item.value)"
            >
              {{ item.label }}
            </DropdownMenuItem>
          </template>
          <DropdownMenuSeparator
            v-if="gi < groups.length - 1"
            class="-mx-1 my-1 h-px bg-muted"
          />
        </template>
        <slot />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
```

### Step 10: 创建 Dialog.vue

- [ ] 创建 `src/design-system/components/Dialog.vue`

基于 Radix Vue `DialogRoot`，模态对话框，支持标题、描述、关闭按钮。

```vue
<!-- src/design-system/components/Dialog.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useI18n } from "vue-i18n"
import { X } from "lucide-vue-next"
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "reka-ui"
import { cn } from "../utils"

const props = withDefaults(defineProps<{
  open?: boolean
  title?: string
  description?: string
  class?: HTMLAttributes["class"]
}>(), {
  open: undefined,
  title: "",
  description: "",
})

const emits = defineEmits<{
  "update:open": [value: boolean]
}>()

const { t } = useI18n()
</script>

<template>
  <DialogRoot :open="open" @update:open="emits('update:open', $event)">
    <DialogTrigger as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogContent
        data-slot="dialog"
        :class="cn(
          'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-background p-6 shadow-lg',
          'duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
          'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
          'rounded-lg',
          props.class,
        )"
      >
        <div class="flex flex-col gap-1.5 text-center sm:text-left">
          <DialogTitle v-if="title" class="text-lg font-semibold leading-none tracking-tight">
            {{ title }}
          </DialogTitle>
          <DialogDescription v-if="description" class="text-sm text-muted-foreground">
            {{ description }}
          </DialogDescription>
        </div>
        <slot />
        <DialogClose
          class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          :aria-label="t('common.close')"
        >
          <X class="size-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
```

### Step 11: 创建 Tabs.vue

- [ ] 创建 `src/design-system/components/Tabs.vue`

基于 Radix Vue `TabsRoot`，支持通过 props 定义 tabs 或使用 slot 自定义。

```vue
<!-- src/design-system/components/Tabs.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "reka-ui"
import { cn } from "../utils"

export interface TabItem {
  label: string
  value: string
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue?: string
  defaultValue?: string
  tabs?: TabItem[]
  class?: HTMLAttributes["class"]
}>(), {
  modelValue: undefined,
  defaultValue: undefined,
  tabs: () => [],
})

const emits = defineEmits<{
  "update:modelValue": [value: string]
}>()
</script>

<template>
  <TabsRoot
    data-slot="tabs"
    :model-value="modelValue"
    :default-value="defaultValue"
    :class="cn('flex flex-col', props.class)"
    @update:model-value="emits('update:modelValue', $event)"
  >
    <TabsList class="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground">
      <slot name="triggers">
        <TabsTrigger
          v-for="tab in tabs"
          :key="tab.value"
          :value="tab.value"
          :disabled="tab.disabled"
          class="inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
        >
          {{ tab.label }}
        </TabsTrigger>
      </slot>
    </TabsList>

    <template v-if="tabs.length">
      <TabsContent
        v-for="tab in tabs"
        :key="tab.value"
        :value="tab.value"
        class="mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <slot :name="tab.value" />
      </TabsContent>
    </template>
    <template v-else>
      <slot />
    </template>
  </TabsRoot>
</template>
```

### Step 12: Batch 3 验证

- [ ] 确认 `Dropdown.vue` 点击触发、分组显示、destructive 样式、select 事件
- [ ] 确认 `Dialog.vue` 打开/关闭动画、标题/描述渲染、ESC 关闭、点击 overlay 关闭
- [ ] 确认 `Tabs.vue` 切换 tab 内容、disabled tab 不可点击、slot 模式和 props 模式都能工作
- [ ] 提交：`feat(p1): design-system — Dropdown, Dialog, Tabs`

---

## Batch 4: 状态指示组件 + 统一导出

**Commit:** `feat(p1): design-system — Badge, Toggle, ProgressBar, index export`

### Step 13: 创建 Badge.vue

- [ ] 创建 `src/design-system/components/Badge.vue`

状态徽章，variant: `success` / `warning` / `danger` / `idle`，可选圆点指示器。

```vue
<!-- src/design-system/components/Badge.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"
import { cn } from "../utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        danger: "bg-destructive/15 text-destructive",
        idle: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "idle",
    },
  },
)

type BadgeVariants = VariantProps<typeof badgeVariants>

const props = withDefaults(defineProps<{
  variant?: BadgeVariants["variant"]
  dot?: boolean
  class?: HTMLAttributes["class"]
}>(), {
  variant: "idle",
  dot: false,
})
</script>

<template>
  <span
    data-slot="badge"
    :data-variant="variant"
    :class="cn(badgeVariants({ variant }), props.class)"
  >
    <span
      v-if="dot"
      class="size-1.5 rounded-full"
      :class="{
        'bg-emerald-500': variant === 'success',
        'bg-amber-500': variant === 'warning',
        'bg-destructive': variant === 'danger',
        'bg-muted-foreground': variant === 'idle',
      }"
      aria-hidden="true"
    />
    <slot />
  </span>
</template>
```

### Step 14: 创建 Toggle.vue

- [ ] 创建 `src/design-system/components/Toggle.vue`

开关切换，基于 Radix Vue `SwitchRoot`。

```vue
<!-- src/design-system/components/Toggle.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { SwitchRoot, SwitchThumb } from "reka-ui"
import { cn } from "../utils"

const props = withDefaults(defineProps<{
  modelValue?: boolean
  defaultValue?: boolean
  disabled?: boolean
  label?: string
  class?: HTMLAttributes["class"]
}>(), {
  modelValue: undefined,
  defaultValue: false,
  disabled: false,
  label: "",
})

const emits = defineEmits<{
  "update:modelValue": [value: boolean]
}>()
</script>

<template>
  <SwitchRoot
    data-slot="toggle"
    :checked="modelValue"
    :default-checked="defaultValue"
    :disabled="disabled"
    :aria-label="label"
    :class="cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
      props.class,
    )"
    @update:checked="emits('update:modelValue', $event)"
  >
    <SwitchThumb
      class="pointer-events-none block size-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
    />
  </SwitchRoot>
</template>
```

### Step 15: 创建 ProgressBar.vue

- [ ] 创建 `src/design-system/components/ProgressBar.vue`

进度条，value 0-100，variant: `accent` / `warning` / `danger`。

```vue
<!-- src/design-system/components/ProgressBar.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"
import { cn } from "../utils"

const barVariants = cva("h-full rounded-full transition-all duration-300 ease-in-out", {
  variants: {
    variant: {
      accent: "bg-primary",
      warning: "bg-amber-500",
      danger: "bg-destructive",
    },
  },
  defaultVariants: {
    variant: "accent",
  },
})

type BarVariants = VariantProps<typeof barVariants>

const props = withDefaults(defineProps<{
  value?: number
  variant?: BarVariants["variant"]
  max?: number
  class?: HTMLAttributes["class"]
}>(), {
  value: 0,
  variant: "accent",
  max: 100,
})

const clampedValue = computed(() => {
  const pct = (props.value / props.max) * 100
  return Math.max(0, Math.min(100, pct))
})
</script>

<template>
  <div
    data-slot="progress-bar"
    role="progressbar"
    :aria-valuenow="value"
    :aria-valuemin="0"
    :aria-valuemax="max"
    :class="cn(
      'relative h-2 w-full overflow-hidden rounded-full bg-primary/20',
      props.class,
    )"
  >
    <div
      :class="cn(barVariants({ variant }))"
      :style="{ width: `${clampedValue}%` }"
    />
  </div>
</template>
```

### Step 16: 创建统一导出 index.ts

- [ ] 创建 `src/design-system/index.ts`

```typescript
// src/design-system/index.ts

// Utils
export { cn } from "./utils"

// Components
export { default as Button } from "./components/Button.vue"
export { buttonVariants } from "./components/button-variants"
export type { ButtonVariants } from "./components/button-variants"

export { default as Input } from "./components/Input.vue"

export { default as Textarea } from "./components/Textarea.vue"

export { default as Select } from "./components/Select.vue"
export type { SelectOption, SelectGroup } from "./components/Select.vue"

export { default as ScrollArea } from "./components/ScrollArea.vue"

export { default as Tooltip } from "./components/Tooltip.vue"

export { default as Dropdown } from "./components/Dropdown.vue"
export type { DropdownItem, DropdownGroup } from "./components/Dropdown.vue"

export { default as Dialog } from "./components/Dialog.vue"

export { default as Tabs } from "./components/Tabs.vue"
export type { TabItem } from "./components/Tabs.vue"

export { default as Badge } from "./components/Badge.vue"

export { default as Toggle } from "./components/Toggle.vue"

export { default as ProgressBar } from "./components/ProgressBar.vue"
```

### Step 17: i18n 补充

- [ ] 确认 `src/i18n/locales/zh-CN.ts` 和 `en-US.ts` 包含以下 key：

```typescript
// 需要的 i18n keys
{
  common: {
    close: "关闭" / "Close",
    inputError: "输入有误" / "Input error",
  }
}
```

### Step 18: Batch 4 验证

- [ ] 确认 `Badge.vue` 四种 variant 颜色正确，dot 圆点显示
- [ ] 确认 `Toggle.vue` checked/unchecked 状态切换，disabled 不可操作
- [ ] 确认 `ProgressBar.vue` value 0-100 进度渲染正确，variant 颜色切换
- [ ] 确认 `index.ts` 所有 12 个组件和类型都能正确导出
- [ ] 运行 `npm run build` 通过 vue-tsc 类型检查
- [ ] 提交：`feat(p1): design-system — Badge, Toggle, ProgressBar, index export`

---

## 全局检查

- [ ] 所有组件 `data-slot` 属性已添加
- [ ] 所有组件颜色仅使用 design token class（`bg-primary`、`text-foreground` 等）
- [ ] 所有组件 dark 模式通过 `dark:` 变体或 token 自动适配
- [ ] 所有组件 TypeScript props 完整，无 `any`
- [ ] 使用 Radix Vue 原语的组件自动带 aria 无障碍属性
- [ ] 自定义元素（Badge、ProgressBar）手动添加了 `role` 和 `aria-*`
- [ ] 用户可见文本（Dialog 关闭按钮 aria-label）使用 i18n
- [ ] `npm run build` 通过，无类型错误
- [ ] ESLint taste-lint 规则通过（无硬编码颜色、无原生表单元素违规）
