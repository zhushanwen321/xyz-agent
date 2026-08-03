// ui 包 popover 原语（w6 chat-ui-and-shell T2，从 renderer components/ui/popover 迁入）。
// 只迁 message-stream 用到的：Popover/PopoverContent + PopoverAnchor/PopoverClose(reka re-export)。
// PopoverTrigger/PopoverTriggerButton/PopoverListItem/PopoverActionItem 未消费不迁（P5/B8 补全）。
export { default as Popover } from './Popover.vue'
export { default as PopoverContent } from './PopoverContent.vue'
export { PopoverAnchor, PopoverClose } from 'reka-ui'
