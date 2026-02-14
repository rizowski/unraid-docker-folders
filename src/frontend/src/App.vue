<template>
  <div id="unraid-docker-modern">
    <header class="header">
      <h1>Docker Containers</h1>
      <div class="connection-status">
        <span class="status-indicator" :class="connectionStatus"></span>
        <span class="status-text">{{ connectionStatusText }}</span>
      </div>
    </header>

    <main class="main-content">
      <div v-if="loading" class="loading">
        <p>Loading containers...</p>
      </div>

      <div v-else-if="error" class="error">
        <p>Error loading containers: {{ error }}</p>
        <button @click="loadContainers">Retry</button>
      </div>

      <div v-else-if="containers.length === 0" class="empty-state">
        <p>No Docker containers found</p>
      </div>

      <div v-else class="container-list">
        <div
          v-for="container in containers"
          :key="container.id"
          class="container-card"
        >
          <div class="container-header">
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
              @click="stopContainer(container.id)"
              class="btn btn-stop"
            >
              Stop
            </button>
            <button
              v-else
              @click="startContainer(container.id)"
              class="btn btn-start"
            >
              Start
            </button>
            <button @click="restartContainer(container.id)" class="btn btn-restart">
              Restart
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

interface Container {
  id: string
  name: string
  image: string
  state: string
  status: string
}

const containers = ref<Container[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const connected = ref(false)

const connectionStatus = computed(() => ({
  connected: connected.value,
  disconnected: !connected.value
}))

const connectionStatusText = computed(() =>
  connected.value ? 'Connected' : 'Disconnected'
)

async function loadContainers() {
  loading.value = true
  error.value = null

  try {
    const response = await fetch('/plugins/unraid-docker-modern/api/containers.php')

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()
    containers.value = data.containers || []
    connected.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
    connected.value = false
  } finally {
    loading.value = false
  }
}

async function startContainer(id: string) {
  try {
    const response = await fetch(
      `/plugins/unraid-docker-modern/api/containers.php?action=start&id=${id}`,
      { method: 'POST' }
    )

    if (!response.ok) {
      throw new Error(`Failed to start container`)
    }

    await loadContainers()
  } catch (e) {
    console.error('Error starting container:', e)
  }
}

async function stopContainer(id: string) {
  try {
    const response = await fetch(
      `/plugins/unraid-docker-modern/api/containers.php?action=stop&id=${id}`,
      { method: 'POST' }
    )

    if (!response.ok) {
      throw new Error(`Failed to stop container`)
    }

    await loadContainers()
  } catch (e) {
    console.error('Error stopping container:', e)
  }
}

async function restartContainer(id: string) {
  try {
    const response = await fetch(
      `/plugins/unraid-docker-modern/api/containers.php?action=restart&id=${id}`,
      { method: 'POST' }
    )

    if (!response.ok) {
      throw new Error(`Failed to restart container`)
    }

    await loadContainers()
  } catch (e) {
    console.error('Error restarting container:', e)
  }
}

onMounted(() => {
  loadContainers()
})
</script>

<style scoped>
/* Basic styling for Phase 1 */
/* Will be replaced with design system in Phase 4 */

#unraid-docker-modern {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, sans-serif;
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 2px solid #e0e0e0;
}

.header h1 {
  margin: 0;
  font-size: 28px;
  color: #333;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-indicator {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.status-indicator.connected {
  background-color: #4caf50;
}

.status-indicator.disconnected {
  background-color: #f44336;
}

.status-text {
  font-size: 14px;
  color: #666;
}

.main-content {
  min-height: 400px;
}

.loading,
.error,
.empty-state {
  text-align: center;
  padding: 60px 20px;
}

.error {
  color: #f44336;
}

.error button {
  margin-top: 16px;
  padding: 8px 24px;
  background-color: #f44336;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.error button:hover {
  background-color: #d32f2f;
}

.container-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 20px;
}

.container-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 20px;
  background-color: white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transition: box-shadow 0.2s;
}

.container-card:hover {
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.container-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.container-header h3 {
  margin: 0;
  font-size: 18px;
  color: #333;
}

.container-status {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
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
  margin-bottom: 16px;
}

.container-info p {
  margin: 4px 0;
  font-size: 14px;
  color: #666;
}

.container-image {
  font-family: 'Courier New', monospace;
}

.container-id {
  font-family: 'Courier New', monospace;
  font-size: 12px;
  color: #999;
}

.container-actions {
  display: flex;
  gap: 8px;
}

.btn {
  flex: 1;
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-start {
  background-color: #4caf50;
  color: white;
}

.btn-start:hover {
  background-color: #45a049;
}

.btn-stop {
  background-color: #f44336;
  color: white;
}

.btn-stop:hover {
  background-color: #d32f2f;
}

.btn-restart {
  background-color: #2196f3;
  color: white;
}

.btn-restart:hover {
  background-color: #1976d2;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
