// ui 包 dialog 原语（w6 chat-ui-and-shell T2，从 renderer components/ui/dialog 迁入）。
// 只迁 message-stream 用到的：Dialog/DialogContent/DialogDescription/DialogTitle + DialogClose(reka re-export)。
// DialogHeader/ConfirmDialog 未消费不迁（P5/B8 统一迁时补全）。
export { default as Dialog } from './Dialog.vue'
export { default as DialogContent } from './DialogContent.vue'
export { default as DialogDescription } from './DialogDescription.vue'
export { default as DialogTitle } from './DialogTitle.vue'
export { DialogClose } from 'reka-ui'
