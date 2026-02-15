<template>
  <div class="container-card" :data-container-id="container.id">
    <div class="container-header">
      <img
        v-if="container.icon"
        :src="container.icon"
        :alt="container.name"
        class="container-icon"
      />
      <h3>{{ container.name }}</h3>
      <span class="container-status" :class="container.state">
        {{ container.state }}
      </span>
    </div>
    <div class="container-info">
      <p class="container-image">{{ container.image }}</p>
      <p class="container-id">{{ container.id.substring(0, 12) }}</p>
    </div>
    <div class="container-actions">
      <button
        v-if="container.state === 'running'"
        @click="$emit('stop', container.id)"
        class="btn btn-stop"
        :disabled="actionInProgress"
      >
        Stop
      </button>
      <button
        v-else
        @click="$emit('start', container.id)"
        class="btn btn-start"
        :disabled="actionInProgress"
      >
        Start
      </button>
      <button
        @click="$emit('restart', container.id)"
        class="btn btn-restart"
        :disabled="actionInProgress"
      >
        Restart
      </button>
      <button
        @click="$emit('remove', container.id)"
        class="btn btn-remove"
        :disabled="actionInProgress || container.state === 'running'"
        :title="container.state === 'running' ? 'Stop container before removing' : 'Remove container'"
      >
        Remove
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Container } from '@/stores/docker';

interface Props {
  container: Container;
  actionInProgress?: boolean;
}

defineProps<Props>();

defineEmits<{
  start: [id: string];
  stop: [id: string];
  restart: [id: string];
  remove: [id: string];
}>();
</script>

<style scoped>
.container-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--spacing-lg);
  background-color: var(--color-background);
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.2s, transform 0.2s;
  cursor: grab;
}

.container-card:hover {
  box-shadow: var(--shadow-md);
}

.container-card:active {
  cursor: grabbing;
}

.container-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
}

.container-icon {
  width: 32px;
  height: 32px;
  object-fit: contain;
  flex-shrink: 0;
}

.container-header h3 {
  margin: 0;
  flex: 1;
  font-size: var(--font-size-lg);
  color: var(--color-text);
}

.container-status {
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
}

.container-status.running {
  background-color: #e8f5e9;
  color: #2e7d32;
}

.container-status.exited,
.container-status.stopped {
  background-color: #ffebee;
  color: #c62828;
}

.container-info {
  margin-bottom: var(--spacing-md);
}

.container-info p {
  margin: var(--spacing-xs) 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.container-image {
  font-family: 'Courier New', monospace;
}

.container-id {
  font-family: 'Courier New', monospace;
  font-size: var(--font-size-xs);
  color: #999;
}

.container-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.btn {
  flex: 1;
  padding: var(--spacing-sm) var(--spacing-md);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-start {
  background-color: var(--color-success);
  color: white;
}

.btn-start:hover:not(:disabled) {
  background-color: #45a049;
}

.btn-stop {
  background-color: var(--color-error);
  color: white;
}

.btn-stop:hover:not(:disabled) {
  background-color: #d32f2f;
}

.btn-restart {
  background-color: var(--color-primary);
  color: white;
}

.btn-restart:hover:not(:disabled) {
  background-color: #1976d2;
}

.btn-remove {
  background-color: #757575;
  color: white;
}

.btn-remove:hover:not(:disabled) {
  background-color: #d32f2f;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
