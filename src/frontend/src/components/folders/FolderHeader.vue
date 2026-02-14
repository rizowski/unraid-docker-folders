<template>
  <div class="folder-header" :style="{ borderLeftColor: folder.color || '#2196f3' }">
    <div class="folder-info">
      <button class="collapse-btn" @click="$emit('toggle-collapse')" :aria-label="folder.collapsed ? 'Expand folder' : 'Collapse folder'">
        <span class="collapse-icon">{{ folder.collapsed ? '▶' : '▼' }}</span>
      </button>
      <span class="folder-icon" v-if="folder.icon">{{ folder.icon }}</span>
      <h2 class="folder-name">{{ folder.name }}</h2>
      <span class="container-count">{{ folder.containers.length }}</span>
    </div>
    <div class="folder-actions">
      <button class="action-btn" @click="$emit('edit')" title="Edit folder">
        ✏️
      </button>
      <button class="action-btn" @click="$emit('delete')" title="Delete folder">
        🗑️
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Folder } from '@/types/folder';

interface Props {
  folder: Folder;
}

defineProps<Props>();

defineEmits<{
  'toggle-collapse': [];
  edit: [];
  delete: [];
}>();
</script>

<style scoped>
.folder-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
  background-color: #f5f5f5;
  border-left: 4px solid var(--color-primary);
  border-radius: var(--radius-sm);
  margin-bottom: var(--spacing-md);
  cursor: pointer;
  user-select: none;
}

.folder-header:hover {
  background-color: #eeeeee;
}

.folder-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
}

.collapse-btn {
  background: none;
  border: none;
  padding: var(--spacing-xs);
  cursor: pointer;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}

.collapse-icon {
  transition: transform 0.2s;
}

.folder-icon {
  font-size: var(--font-size-xl);
}

.folder-name {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
}

.container-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 var(--spacing-sm);
  background-color: var(--color-primary);
  color: white;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.folder-actions {
  display: flex;
  gap: var(--spacing-xs);
}

.action-btn {
  background: none;
  border: none;
  padding: var(--spacing-xs) var(--spacing-sm);
  cursor: pointer;
  font-size: var(--font-size-md);
  opacity: 0.6;
  transition: opacity 0.2s, transform 0.1s;
}

.action-btn:hover {
  opacity: 1;
  transform: scale(1.1);
}
</style>
