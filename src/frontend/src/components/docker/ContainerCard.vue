<template>
  <!-- Grid (card) view -->
  <div v-if="view === 'grid'" class="flex flex-col border border-border/50 rounded-lg bg-bg-card hover:border-border transition" :data-container-id="container.id">
    <div class="flex items-center gap-2 p-6 pb-0">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="drag-handle shrink-0 text-muted cursor-grab active:cursor-grabbing"
      >
        <circle cx="9" cy="5" r="1" />
        <circle cx="9" cy="12" r="1" />
        <circle cx="9" cy="19" r="1" />
        <circle cx="15" cy="5" r="1" />
        <circle cx="15" cy="12" r="1" />
        <circle cx="15" cy="19" r="1" />
      </svg>
      <img :src="container.icon || fallbackIcon" :alt="container.name" class="w-10 h-10 object-contain shrink-0" />
      <span class="w-3 h-3 rounded-full shrink-0" :class="statusDotClass" :title="statusTooltip"></span>
      <h3 class="flex-1 text-lg font-semibold text-text truncate">{{ container.name }}</h3>
    </div>

    <!-- Clickable summary row -->
    <div class="flex items-center gap-2 px-6 py-2 cursor-pointer select-none" @click="expanded = !expanded">
      <p class="flex-1 text-sm text-text-secondary font-mono truncate">
        <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="hover:underline" @click.stop>{{ container.image }}</a>
        <span v-else>{{ container.image }}</span>
      </p>
      <span class="text-xs text-muted">{{ container.status }}</span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="shrink-0 text-muted transition-transform duration-200"
        :class="expanded ? 'rotate-180' : ''"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>

    <!-- Compact stats bars (always visible for running containers) -->
    <div v-if="isRunning && containerStats && !expanded" class="px-6 pb-1 space-y-1">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted w-8 shrink-0">CPU</span>
        <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="cpuBarColor"
            :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"
          ></div>
        </div>
        <span class="text-text-secondary font-mono w-12 text-right shrink-0">{{ formatPercent(containerStats.cpuPercent) }}</span>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted w-8 shrink-0">MEM</span>
        <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="memBarColor"
            :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
          ></div>
        </div>
        <span class="text-text-secondary font-mono w-12 text-right shrink-0">{{ formatPercent(containerStats.memoryPercent) }}</span>
      </div>
    </div>

    <!-- Accordion details -->
    <div v-if="expanded" class="px-6 pb-2 space-y-3 text-sm border-t border-border pt-3">
      <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <template v-if="container.image">
          <span class="text-muted shrink-0">Image</span>
          <span class="text-text-secondary font-mono truncate">
            <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="hover:underline" @click.stop>{{ container.image }}</a>
            <span v-else>{{ container.image }}</span>
          </span>
        </template>
        <template v-if="networkInfo">
          <span class="text-muted shrink-0">Network</span>
          <span class="text-text-secondary font-mono truncate">{{ networkInfo.name }} {{ networkInfo.ip }}</span>
        </template>
        <template v-if="displayPorts.length">
          <span class="text-muted shrink-0">Ports</span>
          <span class="text-text-secondary font-mono truncate">{{ displayPorts.join(', ') }}</span>
        </template>
        <template v-if="displayMounts.length">
          <span class="text-muted shrink-0">Volumes</span>
          <div class="text-text-secondary font-mono space-y-0.5">
            <p v-for="mount in displayMounts" :key="mount.destination" class="truncate" :title="`${mount.destination} -> ${mount.source}`">
              {{ mount.destination }} -&gt; <a :href="`/Shares/Browse?dir=${encodeURIComponent(mount.source)}`" class="hover:underline" @click.stop>{{ mount.sourceShort }}</a>
            </p>
          </div>
        </template>
      </div>
      <div v-if="!container.image && !networkInfo && !displayPorts.length && !displayMounts.length" class="text-muted text-xs italic">No additional details available</div>

      <!-- Resource Usage Stats -->
      <div v-if="isRunning && containerStats" class="space-y-2 pt-2 border-t border-border">
        <p class="text-muted text-xs">Resource Usage</p>
        <!-- CPU Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">CPU</span>
            <span class="text-text-secondary font-mono">{{ formatPercent(containerStats.cpuPercent) }}</span>
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="cpuBarColor"
              :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"
            ></div>
          </div>
        </div>
        <!-- Memory Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">Memory</span>
            <span class="text-text-secondary font-mono"
              >{{ formatBytes(containerStats.memoryUsage) }} / {{ formatBytes(containerStats.memoryLimit) }} ({{
                formatPercent(containerStats.memoryPercent)
              }})</span
            >
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="memBarColor"
              :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
            ></div>
          </div>
        </div>
        <!-- Numeric Stats -->
        <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs pt-1">
          <span class="text-muted">Block I/O</span>
          <span class="text-text-secondary font-mono"
            >Read: {{ formatBytes(containerStats.blockRead) }} / Write: {{ formatBytes(containerStats.blockWrite) }}</span
          >
          <span class="text-muted">Network</span>
          <span class="text-text-secondary font-mono">RX: {{ formatBytes(containerStats.netRx) }} / TX: {{ formatBytes(containerStats.netTx) }}</span>
          <span class="text-muted">PIDs</span>
          <span class="text-text-secondary font-mono">{{ containerStats.pids }}</span>
          <span class="text-muted">Restarts</span>
          <span class="font-mono" :class="restartClass">{{ containerStats.restartCount }}</span>
          <span class="text-muted">Uptime</span>
          <span class="text-text-secondary font-mono">{{ formatUptime(containerStats.startedAt) }}</span>
          <span class="text-muted">Image Size</span>
          <span class="text-text-secondary font-mono">{{ formatBytes(containerStats.imageSize) }}</span>
          <span class="text-muted">Log Size</span>
          <span class="font-mono" :class="logSizeClass">{{ formatBytes(containerStats.logSize) }}</span>
        </div>
      </div>
      <div v-else-if="isRunning && !containerStats" class="text-muted text-xs italic pt-2 border-t border-border">Loading stats...</div>
      <div v-else-if="!isRunning && expanded" class="text-muted text-xs italic pt-2 border-t border-border">Container not running</div>
    </div>

    <div class="flex items-center gap-3 px-6 pb-4 pt-2 mt-auto border-t border-border/30">
      <button
        v-if="container.state === 'running'"
        @click="confirmStop"
        class="p-2 border-none rounded cursor-pointer transition text-error hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Stop"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      </button>
      <button
        v-else
        @click="emit('start', container.id)"
        class="p-2 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Start"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <polygon points="6,3 20,12 6,21" />
        </svg>
      </button>
      <button
        @click="confirmRestart"
        class="p-2 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Restart"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
      <button
        v-if="container.state !== 'running'"
        @click="confirmRemove"
        class="p-2 border-none rounded cursor-pointer transition text-muted hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Remove"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
      <a v-if="editUrl" :href="editUrl" class="ml-auto shrink-0 text-text-secondary hover:text-text transition p-2" title="Edit container" @click.stop>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </a>
      <!-- Kebab menu -->
      <div ref="menuRef" class="relative" :class="{ 'ml-auto': !editUrl }">
        <button class="p-2 border-none rounded cursor-pointer transition text-text-secondary hover:text-text" title="More actions" @click.stop="toggleMenu">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
          </svg>
        </button>
        <div v-if="menuOpen" class="absolute right-0 bottom-full mb-1 bg-bg border border-border rounded-lg shadow-lg py-1 min-w-[160px] z-50">
          <template v-for="item in menuItems" :key="item.label">
            <a
              v-if="item.show"
              :href="item.href"
              :target="item.target"
              rel="noopener"
              class="flex items-center gap-2.5 px-3 py-2 text-sm text-text hover:bg-border/50 transition no-underline"
              @click="closeMenu"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path v-for="(d, i) in item.icon.split('|')" :key="i" :d="d" />
              </svg>
              {{ item.label }}
            </a>
          </template>
        </div>
      </div>
    </div>
  </div>

  <!-- List view -->
  <div v-else class="rounded hover:bg-bg-card transition border-b border-border/50" :data-container-id="container.id">
    <div class="flex items-center gap-4 px-4 py-3">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="drag-handle shrink-0 text-muted cursor-grab active:cursor-grabbing -mr-2"
      >
        <circle cx="9" cy="5" r="1" />
        <circle cx="9" cy="12" r="1" />
        <circle cx="9" cy="19" r="1" />
        <circle cx="15" cy="5" r="1" />
        <circle cx="15" cy="12" r="1" />
        <circle cx="15" cy="19" r="1" />
      </svg>
      <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="statusDotClass" :title="statusTooltip"></span>
      <img :src="container.icon || fallbackIcon" :alt="container.name" class="w-12 h-12 object-contain shrink-0" />

      <!-- Clickable name/image area toggles accordion -->
      <div class="flex items-center gap-4 flex-1 min-w-0 cursor-pointer select-none" @click="expanded = !expanded">
        <span class="font-semibold text-text min-w-[140px]">{{ container.name }}</span>
        <span class="text-sm text-text-secondary font-mono truncate">
          <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="hover:underline" @click.stop>{{ container.image }}</a>
          <span v-else>{{ container.image }}</span>
        </span>
        <span class="text-xs text-muted">{{ container.status }}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0 text-muted transition-transform duration-200"
          :class="expanded ? 'rotate-180' : ''"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      <!-- Inline compact stats (list view) -->
      <div v-if="isRunning && containerStats && !expanded" class="shrink-0 w-[140px] space-y-0.5">
        <div class="flex items-center gap-1.5 text-[11px]">
          <span class="text-muted w-7 text-right">CPU</span>
          <div class="flex-1 h-1 bg-border rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="cpuBarColor"
              :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"
            ></div>
          </div>
          <span class="text-text-secondary font-mono w-9 text-right">{{ formatPercent(containerStats.cpuPercent) }}</span>
        </div>
        <div class="flex items-center gap-1.5 text-[11px]">
          <span class="text-muted w-7 text-right">MEM</span>
          <div class="flex-1 h-1 bg-border rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="memBarColor"
              :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
            ></div>
          </div>
          <span class="text-text-secondary font-mono w-9 text-right">{{ formatPercent(containerStats.memoryPercent) }}</span>
        </div>
      </div>

      <div class="flex gap-1.5 ml-auto shrink-0 items-center">
        <a v-if="editUrl" :href="editUrl" class="text-text-secondary hover:text-text transition p-1.5" title="Edit container">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </a>
        <button
          v-if="container.state === 'running'"
          @click="confirmStop"
          class="p-1.5 border-none rounded cursor-pointer transition text-error hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Stop"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
        <button
          v-else
          @click="emit('start', container.id)"
          class="p-1.5 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Start"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <polygon points="6,3 20,12 6,21" />
          </svg>
        </button>
        <button
          @click="confirmRestart"
          class="p-1.5 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Restart"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
        <button
          v-if="container.state !== 'running'"
          @click="confirmRemove"
          class="p-1.5 border-none rounded cursor-pointer transition text-muted hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Remove"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
        <!-- Kebab menu -->
        <div ref="menuRef" class="relative">
          <button class="p-1.5 border-none rounded cursor-pointer transition text-text-secondary hover:text-text" title="More actions" @click.stop="toggleMenu">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
            </svg>
          </button>
          <div v-if="menuOpen" class="absolute right-0 top-full mt-1 bg-bg border border-border rounded-lg shadow-lg py-1 min-w-[160px] z-50">
            <template v-for="item in menuItems" :key="item.label">
              <a
                v-if="item.show"
                :href="item.href"
                :target="item.target"
                rel="noopener"
                class="flex items-center gap-2.5 px-3 py-2 text-sm text-text hover:bg-border/50 transition no-underline"
                @click="closeMenu"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path v-for="(d, i) in item.icon.split('|')" :key="i" :d="d" />
                </svg>
                {{ item.label }}
              </a>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- List accordion details -->
    <div v-if="expanded" class="px-4 pb-4 pt-2 border-t border-border ml-[72px] space-y-3 text-sm">
      <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <template v-if="container.image">
          <span class="text-muted shrink-0">Image</span>
          <span class="text-text-secondary font-mono truncate">
            <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="hover:underline" @click.stop>{{ container.image }}</a>
            <span v-else>{{ container.image }}</span>
          </span>
        </template>
      </div>
      <div v-if="networkInfo || displayPorts.length || displayMounts.length" class="grid grid-cols-2 gap-4">
        <div v-if="networkInfo || displayPorts.length">
          <p class="text-muted text-xs mb-1">Network{{ displayPorts.length ? ' / Ports' : '' }}</p>
          <div class="text-text-secondary font-mono text-xs space-y-0.5">
            <p v-if="networkInfo" class="truncate">{{ networkInfo.name }} {{ networkInfo.ip }}</p>
            <p v-for="port in displayPorts" :key="port" class="truncate">{{ port }}</p>
          </div>
        </div>
        <div v-if="displayMounts.length">
          <p class="text-muted text-xs mb-1">Volumes</p>
          <div class="text-text-secondary font-mono text-xs space-y-0.5">
            <p v-for="mount in displayMounts" :key="mount.destination" class="truncate" :title="`${mount.destination} -> ${mount.source}`">
              {{ mount.destination }} -&gt; <a :href="`/Shares/Browse?dir=${encodeURIComponent(mount.source)}`" class="hover:underline" @click.stop>{{ mount.sourceShort }}</a>
            </p>
          </div>
        </div>
      </div>
      <div v-if="!container.image && !networkInfo && !displayPorts.length && !displayMounts.length" class="text-muted text-xs italic">No additional details available</div>

      <!-- Resource Usage Stats (list view) -->
      <div v-if="isRunning && containerStats" class="space-y-1.5 pt-2 border-t border-border">
        <p class="text-muted text-xs">Resource Usage</p>
        <!-- CPU Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">CPU</span>
            <span class="text-text-secondary font-mono">{{ formatPercent(containerStats.cpuPercent) }}</span>
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="cpuBarColor"
              :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"
            ></div>
          </div>
        </div>
        <!-- Memory Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">Memory</span>
            <span class="text-text-secondary font-mono"
              >{{ formatBytes(containerStats.memoryUsage) }} / {{ formatBytes(containerStats.memoryLimit) }} ({{
                formatPercent(containerStats.memoryPercent)
              }})</span
            >
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="memBarColor"
              :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
            ></div>
          </div>
        </div>
        <!-- Numeric Stats -->
        <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs pt-0.5">
          <span class="text-muted">Block I/O</span>
          <span class="text-text-secondary font-mono"
            >Read: {{ formatBytes(containerStats.blockRead) }} / Write: {{ formatBytes(containerStats.blockWrite) }}</span
          >
          <span class="text-muted">Network</span>
          <span class="text-text-secondary font-mono">RX: {{ formatBytes(containerStats.netRx) }} / TX: {{ formatBytes(containerStats.netTx) }}</span>
          <span class="text-muted">PIDs</span>
          <span class="text-text-secondary font-mono">{{ containerStats.pids }}</span>
          <span class="text-muted">Restarts</span>
          <span class="font-mono" :class="restartClass">{{ containerStats.restartCount }}</span>
          <span class="text-muted">Uptime</span>
          <span class="text-text-secondary font-mono">{{ formatUptime(containerStats.startedAt) }}</span>
          <span class="text-muted">Image Size</span>
          <span class="text-text-secondary font-mono">{{ formatBytes(containerStats.imageSize) }}</span>
          <span class="text-muted">Log Size</span>
          <span class="font-mono" :class="logSizeClass">{{ formatBytes(containerStats.logSize) }}</span>
        </div>
      </div>
      <div v-else-if="isRunning && !containerStats" class="text-muted text-xs italic pt-2 border-t border-border">Loading stats...</div>
      <div v-else-if="!isRunning && expanded" class="text-muted text-xs italic pt-2 border-t border-border">Container not running</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, onMounted, onUnmounted, type Ref } from 'vue';
import type { Container } from '@/stores/docker';
import { useStatsStore } from '@/stores/stats';
import { useSettingsStore } from '@/stores/settings';
import { formatBytes, formatPercent, formatUptime } from '@/utils/format';
// Vite copies public/ files to outDir root; BASE_URL ensures correct path in dev + prod
const fallbackIcon = `${import.meta.env.BASE_URL}docker.svg`;

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function closeMenu() {
  menuOpen.value = false;
}

function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', onClickOutside, true));
onUnmounted(() => document.removeEventListener('click', onClickOutside, true));

interface Props {
  container: Container;
  actionInProgress?: boolean;
  view?: 'grid' | 'list';
}

const props = withDefaults(defineProps<Props>(), {
  view: 'grid',
});

const emit = defineEmits<{
  start: [id: string];
  stop: [id: string];
  restart: [id: string];
  remove: [id: string];
}>();

function confirmStop() {
  if (confirm(`Stop container "${props.container.name}"?`)) {
    emit('stop', props.container.id);
  }
}

function confirmRestart() {
  if (confirm(`Restart container "${props.container.name}"?`)) {
    emit('restart', props.container.id);
  }
}

function confirmRemove() {
  if (confirm(`Remove container "${props.container.name}"? This cannot be undone.`)) {
    emit('remove', props.container.id);
  }
}

const expanded = ref(false);
const statsStore = useStatsStore();
const settingsStore = useSettingsStore();

const showStats = computed(() => settingsStore.showStats);
const containerStats = computed(() => showStats.value ? statsStore.getStats(props.container.id) : null);
const isRunning = computed(() => props.container.state === 'running');

const cpuBarColor = computed(() => {
  const pct = containerStats.value?.cpuPercent ?? 0;
  if (pct > 80) return 'bg-error';
  if (pct > 50) return 'bg-warning';
  return 'bg-success';
});

const memBarColor = computed(() => {
  const pct = containerStats.value?.memoryPercent ?? 0;
  if (pct > 80) return 'bg-error';
  if (pct > 50) return 'bg-warning';
  return 'bg-success';
});

const logSizeClass = computed(() => {
  const size = containerStats.value?.logSize ?? 0;
  if (size > 1_073_741_824) return 'text-error';
  if (size > 104_857_600) return 'text-warning';
  return 'text-text-secondary';
});

const restartClass = computed(() => {
  return (containerStats.value?.restartCount ?? 0) > 0 ? 'text-error' : 'text-text-secondary';
});

// Register running containers for compact bar polling (only when stats enabled)
onMounted(() => {
  if (showStats.value && isRunning.value) {
    statsStore.registerVisible(props.container.id);
  }
});

// React to container state changes (start/stop)
watch(isRunning, (running) => {
  if (!showStats.value) return;
  if (running) {
    statsStore.registerVisible(props.container.id);
  } else {
    statsStore.unregisterVisible(props.container.id);
  }
});

// React to showStats toggling on/off
watch(showStats, (enabled) => {
  if (enabled) {
    if (isRunning.value) statsStore.registerVisible(props.container.id);
    if (expanded.value) statsStore.registerExpanded(props.container.id);
  } else {
    statsStore.unregisterVisible(props.container.id);
    statsStore.unregisterExpanded(props.container.id);
  }
});

watch(expanded, (val) => {
  if (!showStats.value) return;
  if (val) {
    statsStore.registerExpanded(props.container.id);
  } else {
    statsStore.unregisterExpanded(props.container.id);
  }
});

onUnmounted(() => {
  statsStore.unregisterVisible(props.container.id);
  if (expanded.value) {
    statsStore.unregisterExpanded(props.container.id);
  }
});

const distinguishHealthy = inject<Ref<boolean>>('distinguishHealthy', ref(true));

const isHealthy = computed(() => props.container.status?.toLowerCase().includes('(healthy)'));

const statusDotClass = computed(() => {
  const state = props.container.state;
  if (state === 'running' && distinguishHealthy.value && isHealthy.value) return 'bg-green-500';
  if (state === 'running' && distinguishHealthy.value) return 'bg-blue-500';
  if (state === 'running') return 'bg-green-500';
  if (state === 'exited' || state === 'stopped') return 'bg-red-500';
  return 'bg-gray-400';
});

const statusTooltip = computed(() => {
  const state = props.container.state;
  if (state === 'running' && distinguishHealthy.value && isHealthy.value) return 'Running (healthy)';
  if (state === 'running' && distinguishHealthy.value) return 'Running (no health check)';
  if (state === 'running') return 'Running';
  if (state === 'exited') return 'Exited';
  if (state === 'stopped') return 'Stopped';
  if (state === 'created') return 'Created';
  return state.charAt(0).toUpperCase() + state.slice(1);
});

const editUrl = computed(() => {
  if (props.container.managed !== 'dockerman') return null;
  return `/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-${props.container.name}.xml`;
});

const resolvedWebui = computed(() => {
  const tpl = props.container.webui;
  if (!tpl) return null;
  let url = tpl;
  // Replace [IP] with current hostname
  url = url.replace('[IP]', window.location.hostname);
  // Replace [PORT:xxxx] with the mapped public port
  url = url.replace(/\[PORT:(\d+)\]/g, (_match, privatePort) => {
    const pNum = parseInt(privatePort);
    const mapped = props.container.ports?.find((p) => p.PrivatePort === pNum);
    return mapped?.PublicPort ? String(mapped.PublicPort) : privatePort;
  });
  return url;
});

const consoleUrl = computed(() => {
  const shell = props.container.labels?.['net.unraid.docker.shell'] || '/bin/bash';
  return `/Docker/Terminal?container=${encodeURIComponent(props.container.name)}&cmd=${encodeURIComponent(shell)}`;
});

const logsUrl = computed(() => {
  return `/Docker/Log?container=${encodeURIComponent(props.container.name)}`;
});

const supportUrl = computed(() => {
  return props.container.labels?.['net.unraid.docker.support'] || null;
});

const projectUrl = computed(() => {
  return props.container.labels?.['net.unraid.docker.project'] || null;
});

interface MenuItem {
  label: string;
  icon: string;
  href: string;
  target?: string;
  show: boolean;
}

const menuItems = computed<MenuItem[]>(() => [
  { label: 'WebUI', icon: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6|M15 3h6v6|M10 14 21 3', href: resolvedWebui.value || '', target: '_blank', show: !!resolvedWebui.value && isRunning.value },
  { label: 'Console', icon: 'M4 17l6-5-6-5|M12 19h8', href: consoleUrl.value, target: '_blank', show: isRunning.value },
  { label: 'Logs', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8', href: logsUrl.value, target: '_blank', show: true },
  { label: 'Project', icon: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71|M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71', href: projectUrl.value || imageLink.value || '', target: '_blank', show: !!(projectUrl.value || imageLink.value) },
  { label: 'Support', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', href: supportUrl.value || '', target: '_blank', show: !!supportUrl.value },
]);

const imageLink = computed(() => {
  const image = props.container.image;
  if (!image) return null;
  const nameOnly = image.split(':')[0];
  if (nameOnly.includes('.')) {
    return `https://${nameOnly}`;
  }
  if (nameOnly.includes('/')) {
    return `https://hub.docker.com/r/${nameOnly}`;
  }
  return `https://hub.docker.com/_/${nameOnly}`;
});

const networkInfo = computed(() => {
  const nets = props.container.networkSettings;
  if (!nets) return null;
  const entries = Object.entries(nets);
  if (entries.length === 0) return null;
  const [name, data] = entries[0];
  return { name, ip: data?.IPAddress || '' };
});

const displayPorts = computed(() => {
  const ports = props.container.ports;
  if (!ports?.length) return [];
  return ports.slice(0, 3).map((p) => {
    if (p.PublicPort) {
      return `${p.PrivatePort}/${p.Type} -> ${p.IP || '0.0.0.0'}:${p.PublicPort}`;
    }
    return `${p.PrivatePort}/${p.Type}`;
  });
});

const displayMounts = computed(() => {
  const mounts = props.container.mounts;
  if (!mounts?.length) return [];
  return mounts.slice(0, 2).map((m) => {
    const srcShort = m.Source.length > 30 ? '...' + m.Source.slice(-27) : m.Source;
    return { destination: m.Destination, source: m.Source, sourceShort: srcShort };
  });
});
</script>
