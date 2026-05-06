import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

export interface SlashCommand {
  name: string
  description: string
  execute: (args: string) => void | Promise<void>
}

const commands = ref<SlashCommand[]>([])
const visible = ref(false)
const filter = ref('')

export function useSlashCommands() {
  const { t } = useI18n()

  function registerCommand(cmd: SlashCommand) {
    commands.value = [...commands.value, cmd]
  }

  const filteredCommands = computed(() => {
    if (!filter.value) return commands.value
    return commands.value.filter(cmd =>
      cmd.name.includes(filter.value.toLowerCase())
    )
  })

  function show() { visible.value = true }
  function hide() { visible.value = false }
  function toggle() { visible.value = !visible.value }
  function setFilter(f: string) { filter.value = f }

  // Register built-in commands
  function initDefaultCommands() {
    registerCommand({
      name: 'compact',
      description: t('chat.compacting'),
      execute: () => {
        // TODO: trigger compaction via WS
        console.log('/compact triggered')
      },
    })
    registerCommand({
      name: 'clear',
      description: 'Clear current conversation',
      execute: () => {
        // TODO: clear messages
        console.log('/clear triggered')
      },
    })
    registerCommand({
      name: 'help',
      description: 'Show available commands',
      execute: () => {
        console.log('/help triggered')
      },
    })
  }

  return {
    commands,
    filteredCommands,
    visible,
    filter,
    registerCommand,
    show,
    hide,
    toggle,
    setFilter,
    initDefaultCommands,
  }
}
