<template>
  <div class="branch-indicator" :class="{ 'branch-indicator--active': siblingCount > 1 }">
    <!-- Single child: translucent pill, not clickable -->
    <span
      v-if="siblingCount <= 1"
      class="branch-pill branch-pill--single"
    >1</span>

    <!-- Multiple children: solid pill with dropdown -->
    <template v-else>
      <span
        class="branch-pill branch-pill--multi"
        @click.stop="toggleDropdown"
      >
        {{ siblingCount }}
      </span>

      <!-- Dropdown -->
      <Teleport to="body">
        <div
          v-if="dropdownOpen"
          class="fixed inset-0 z-[900]"
          @click="dropdownOpen = false"
        />
        <div
          v-if="dropdownOpen"
          class="branch-dropdown"
          :style="dropdownStyle"
        >
          <div
            v-for="tab in branchTabs"
            :key="tab.targetId"
            class="branch-dropdown__item"
            :class="{ 'branch-dropdown__item--active': tab.isActive }"
            @click="onSelectBranch(tab)"
          >
            <span class="branch-dropdown__dot" :class="{ 'branch-dropdown__dot--active': tab.isActive }"></span>
            <span class="branch-dropdown__label">{{ tab.label }}</span>
            <span v-if="tab.isActive" class="branch-dropdown__badge">active</span>
          </div>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useTreeStore, type BranchTab } from '../../stores/tree'

const props = defineProps<{
  entryId: string
  siblingCount: number
}>()

const emit = defineEmits<{
  navigate: [targetEntryId: string]
}>()

const treeStore = useTreeStore()
const dropdownOpen = ref(false)
const pillRef = ref<HTMLElement | null>(null)

const branchTabs = computed<BranchTab[]>(() => {
  // Find the path node that contains this entryId to get its branchTabs
  // We need to find the active path for the current session and match
  // Since we don't have sessionId directly, we rely on treeStore's global state
  // The parent component (MessageList) should provide the tabs via the tree
  // For now, return empty - will be populated when integrated with MessageList
  return []
})

const dropdownStyle = computed(() => {
  const pill = pillRef.value
  if (!pill) return {}
  const rect = pill.getBoundingClientRect()
  return {
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
  }
})

function toggleDropdown() {
  dropdownOpen.value = !dropdownOpen.value
}

function onSelectBranch(tab: BranchTab) {
  dropdownOpen.value = false
  emit('navigate', tab.targetId)
}
</script>

<style scoped>
.branch-indicator {
  display: inline-flex;
  align-items: center;
  margin-top: 4px;
}

.branch-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-lg);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

.branch-pill--single {
  background: transparent;
  color: var(--muted);
  opacity: 0.35;
  cursor: default;
}

.branch-pill--multi {
  background: var(--accent-light);
  color: var(--accent);
  cursor: pointer;
  transition: all 0.15s ease;
}
.branch-pill--multi:hover {
  background: var(--accent);
  color: white;
}

.branch-dropdown {
  position: fixed;
  z-index: 901;
  min-width: 160px;
  max-width: 280px;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
}

.branch-dropdown__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  transition: all 0.1s ease;
}
.branch-dropdown__item:hover {
  background: var(--accent-light);
  color: var(--accent);
}
.branch-dropdown__item--active {
  background: var(--accent-light);
}

.branch-dropdown__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}
.branch-dropdown__dot--active {
  background: var(--accent);
}

.branch-dropdown__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch-dropdown__badge {
  font-size: 9px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
</style>
