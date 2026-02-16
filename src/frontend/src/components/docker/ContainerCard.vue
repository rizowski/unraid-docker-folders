<template>
  <!-- Grid (card) view -->
  <div v-if="view === 'grid'" class="container-card-enter flex flex-col border border-border/50 rounded-lg bg-bg-card hover:border-border hover:brightness-[1.03] transition" :class="{ 'state-change-pulse': stateChangePulse }" :data-container-id="container.id">
    <div class="flex items-center gap-2 px-4 sm:px-6 pt-4 sm:pt-6 pb-0">
      <svg
        v-if="!dragLocked"
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
      <img :src="container.icon || fallbackIcon" :alt="container.name" class="w-7 h-7 object-contain shrink-0" />
      <span class="w-3 h-3 rounded-full shrink-0" :class="statusDotClass" :title="statusTooltip"></span>
      <h3 class="flex-1 text-sm font-semibold text-text truncate">{{ container.name }}</h3>
    </div>

    <!-- Clickable summary row -->
    <div class="flex items-center gap-2 px-4 sm:px-6 py-2 cursor-pointer select-none" @click="expanded = !expanded">
      <p class="flex-1 text-[11px] text-text-secondary font-mono truncate">
        <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="inline-flex items-center gap-1 hover:underline" @click.stop><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>{{ container.image }}</a>
        <span v-else>{{ container.image }}</span>
      </p>
      <span class="text-[11px] text-text">{{ container.status }}</span>
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
        class="shrink-0 text-text-secondary transition-transform duration-200"
        :class="expanded ? '' : '-rotate-90'"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>

    <!-- Compact ports (collapsed) -->
    <div v-if="compactPorts && !expanded" class="px-4 sm:px-6 pb-0.5">
      <span class="text-[11px] text-text font-mono">Ports: {{ compactPorts }}</span>
    </div>

    <!-- Compact stats loading state -->
    <div v-if="isRunning && showStats && !containerStats && !expanded" class="px-4 sm:px-6 pb-1 space-y-1">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-text w-8 shrink-0">CPU</span>
        <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
          <div class="h-full w-1/3 rounded-full bg-border animate-pulse"></div>
        </div>
        <span class="text-text font-mono w-12 text-right shrink-0">--</span>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-text w-8 shrink-0">MEM</span>
        <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
          <div class="h-full w-1/4 rounded-full bg-border animate-pulse"></div>
        </div>
        <span class="text-text font-mono w-12 text-right shrink-0">--</span>
      </div>
    </div>

    <!-- Compact stats bars (always visible for running containers) -->
    <div v-if="isRunning && containerStats && !expanded" class="px-4 sm:px-6 pb-1 space-y-1">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-text w-8 shrink-0">CPU</span>
        <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="cpuBarColor"
            :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"
          ></div>
        </div>
        <span class="text-text font-mono w-12 text-right shrink-0">{{ formatPercent(containerStats.cpuPercent) }}</span>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-text w-8 shrink-0">MEM</span>
        <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="memBarColor"
            :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
          ></div>
        </div>
        <span class="text-text font-mono w-12 text-right shrink-0">{{ formatPercent(containerStats.memoryPercent) }}</span>
      </div>
      <div v-if="containerStats.restartCount > 0" class="flex items-center gap-2 text-xs">
        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-error/15 text-error rounded text-[11px] font-mono font-medium">
          {{ containerStats.restartCount }} restart{{ containerStats.restartCount !== 1 ? 's' : '' }}
        </span>
      </div>
    </div>

    <!-- Accordion details -->
    <div v-if="expanded" class="px-4 sm:px-6 pb-2 space-y-3 text-xs border-t border-border pt-3 overflow-hidden">
      <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 min-w-0">
        <template v-if="container.image">
          <span class="text-muted shrink-0">Image</span>
          <span class="text-text-secondary font-mono truncate">
            <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="inline-flex items-center gap-1 hover:underline" @click.stop><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>{{ container.image }}</a>
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
          <div class="text-text-secondary font-mono space-y-0.5 min-w-0 overflow-x-auto">
            <p v-for="mount in displayMounts" :key="mount.destination" class="whitespace-nowrap" :title="`${mount.source} -> ${mount.destination}`">
              <a :href="`/Shares/Browse?dir=${encodeURIComponent(mount.source)}`" class="inline-flex items-center gap-1 hover:underline" @click.stop><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>{{ mount.sourceShort }}</a> -&gt; {{ mount.destination }}
            </p>
          </div>
        </template>
      </div>
      <div v-if="!container.image && !networkInfo && !displayPorts.length && !displayMounts.length" class="text-muted italic">No additional details available</div>

      <!-- Resource Usage Stats -->
      <div v-if="isRunning && containerStats" class="space-y-2 pt-2 border-t border-border">
        <p class="text-muted text-xs">Resource Usage</p>
        <!-- CPU Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">CPU</span>
            <span class="text-text-secondary font-mono">{{ formatPercent(containerStats.cpuPercent) }}</span>
          </div>
          <div class="w-full h-1.5 stats-bar-track rounded-full overflow-hidden">
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
          <div class="w-full h-1.5 stats-bar-track rounded-full overflow-hidden">
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
          <span class="text-text-secondary font-mono truncate">R: {{ formatBytes(containerStats.blockRead) }} / W: {{ formatBytes(containerStats.blockWrite) }}</span>
          <span class="text-muted">Network</span>
          <span class="text-text-secondary font-mono truncate">RX: {{ formatBytes(containerStats.netRx) }} / TX: {{ formatBytes(containerStats.netTx) }}</span>
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
          <template v-if="healthStatus">
            <span class="text-muted">Health</span>
            <span class="font-mono" :class="healthClass">{{ healthStatus }}</span>
          </template>
          <template v-if="container.command">
            <span class="text-muted">Command</span>
            <span class="text-text-secondary font-mono truncate" :title="container.command">{{ container.command }}</span>
          </template>
        </div>
        <!-- Labels -->
        <div v-if="displayLabels.length" class="space-y-1 pt-1 text-xs">
          <p class="text-muted">Labels</p>
          <div class="text-text-secondary font-mono space-y-0.5 min-w-0 overflow-x-auto">
            <p v-for="label in displayLabels" :key="label.key" class="text-[11px] whitespace-nowrap" :title="`${label.key}=${label.value}`">
              <span class="text-text">{{ label.key }}</span>=<span class="text-text-secondary">{{ label.value }}</span>
            </p>
          </div>
        </div>
      </div>
      <!-- Container info when not running (no stats section) -->
      <div v-else class="space-y-2 pt-2 border-t border-border">
        <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <template v-if="healthStatus">
            <span class="text-muted">Health</span>
            <span class="font-mono" :class="healthClass">{{ healthStatus }}</span>
          </template>
          <template v-if="container.command">
            <span class="text-muted">Command</span>
            <span class="text-text-secondary font-mono truncate" :title="container.command">{{ container.command }}</span>
          </template>
        </div>
        <div v-if="displayLabels.length" class="space-y-1 pt-1">
          <p class="text-muted text-xs">Labels</p>
          <div class="text-text-secondary font-mono space-y-0.5 min-w-0 overflow-x-auto">
            <p v-for="label in displayLabels" :key="label.key" class="text-[11px] whitespace-nowrap" :title="`${label.key}=${label.value}`">
              <span class="text-text">{{ label.key }}</span>=<span class="text-text-secondary">{{ label.value }}</span>
            </p>
          </div>
        </div>
        <div v-if="!isRunning && !container.command && !healthStatus && !displayLabels.length" class="text-muted text-xs italic">Container not running</div>
      </div>
    </div>

    <div class="flex items-center gap-3 px-4 pb-3 pt-2 sm:px-6 sm:pb-4 mt-auto border-t border-border/30">
      <button
        v-if="container.state === 'running'"
        @click="confirmAction = 'stop'"
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
        v-if="isRunning"
        @click="confirmAction = 'restart'"
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
        v-if="!isRunning"
        @click="confirmAction = 'remove'"
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
      <a
        v-if="resolvedWebui && isRunning"
        :href="resolvedWebui"
        target="_blank"
        rel="noopener"
        class="ml-auto p-2 rounded text-text-secondary hover:text-primary transition"
        title="Open WebUI"
        @click.stop
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      </a>
      <!-- Kebab menu -->
      <div ref="menuRef" class="relative" :class="{ 'ml-auto': !resolvedWebui || !isRunning }">
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
              class="kebab-menu-item flex items-center gap-2.5 px-3 py-2 text-sm text-text transition no-underline"
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
  <div v-else class="container-card-enter container-row rounded transition border-b border-border/50" :class="{ 'state-change-pulse': stateChangePulse }" :data-container-id="container.id">
    <div class="flex items-center gap-2 sm:gap-4 px-2 sm:px-4 py-3 cursor-pointer select-none" @click="expanded = !expanded">
      <svg
        v-if="!dragLocked"
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
        @click.stop
      >
        <circle cx="9" cy="5" r="1" />
        <circle cx="9" cy="12" r="1" />
        <circle cx="9" cy="19" r="1" />
        <circle cx="15" cy="5" r="1" />
        <circle cx="15" cy="12" r="1" />
        <circle cx="15" cy="19" r="1" />
      </svg>
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
        class="shrink-0 text-text-secondary transition-transform duration-200"
        :class="expanded ? '' : '-rotate-90'"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span class="w-[3px] h-5 rounded-full shrink-0" :class="statusBarClass" :title="statusTooltip"></span>
      <img :src="container.icon || fallbackIcon" :alt="container.name" class="w-7 h-7 object-contain shrink-0" />

      <div class="flex flex-col flex-1 min-w-0 gap-0.5">
        <div class="flex items-center gap-3">
          <span class="text-xs font-semibold text-text">{{ container.name }}</span>
          <span class="text-[11px] text-text-secondary truncate">{{ container.status }}</span>
        </div>
        <span class="text-[11px] text-text-secondary font-mono truncate">
          <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="inline-flex items-center gap-1 hover:underline" @click.stop><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>{{ container.image }}</a>
          <span v-else>{{ container.image }}</span>
        </span>
      </div>

      <!-- Compact ports (list collapsed) -->
      <span v-if="compactPorts && !expanded" class="shrink-0 text-[11px] text-text font-mono">{{ compactPorts }}</span>

      <!-- Inline compact stats loading (list view) -->
      <div v-if="isRunning && showStats && !containerStats && !expanded" class="shrink-0 w-[140px] space-y-0.5">
        <div class="flex items-center gap-1.5 text-[11px]">
          <span class="text-text w-7 text-right">CPU</span>
          <div class="flex-1 h-1 stats-bar-track rounded-full overflow-hidden">
            <div class="h-full w-1/3 rounded-full bg-border animate-pulse"></div>
          </div>
          <span class="text-text font-mono w-9 text-right">--</span>
        </div>
        <div class="flex items-center gap-1.5 text-[11px]">
          <span class="text-text w-7 text-right">MEM</span>
          <div class="flex-1 h-1 stats-bar-track rounded-full overflow-hidden">
            <div class="h-full w-1/4 rounded-full bg-border animate-pulse"></div>
          </div>
          <span class="text-text font-mono w-9 text-right">--</span>
        </div>
      </div>

      <!-- Inline compact stats (list view) -->
      <div v-if="isRunning && containerStats && !expanded" class="shrink-0 flex items-center gap-3">
        <div class="w-[140px] space-y-0.5">
          <div class="flex items-center gap-1.5 text-[11px]">
            <span class="text-text w-7 text-right">CPU</span>
            <div class="flex-1 h-1 stats-bar-track rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-300"
                :class="cpuBarColor"
                :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"
              ></div>
            </div>
            <span class="text-text font-mono w-9 text-right">{{ formatPercent(containerStats.cpuPercent) }}</span>
          </div>
          <div class="flex items-center gap-1.5 text-[11px]">
            <span class="text-text w-7 text-right">MEM</span>
            <div class="flex-1 h-1 stats-bar-track rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-300"
                :class="memBarColor"
                :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
              ></div>
            </div>
            <span class="text-text font-mono w-9 text-right">{{ formatPercent(containerStats.memoryPercent) }}</span>
          </div>
        </div>
        <span v-if="containerStats.restartCount > 0" class="inline-flex items-center px-1.5 py-0.5 bg-error/15 text-error rounded text-[11px] font-mono font-medium shrink-0" :title="`${containerStats.restartCount} restart(s)`">
          {{ containerStats.restartCount }} rst
        </span>
      </div>

      <div class="flex gap-1 ml-auto shrink-0 items-center" @click.stop>
        <a
          v-if="resolvedWebui && isRunning"
          :href="resolvedWebui"
          target="_blank"
          rel="noopener"
          class="flex items-center justify-center w-8 h-8 rounded text-text-secondary hover:text-primary transition"
          title="Open WebUI"
          @click.stop
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </a>
        <button
          v-if="container.state === 'running'"
          @click="confirmAction = 'stop'"
          class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-error hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
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
          class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Start"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <polygon points="6,3 20,12 6,21" />
          </svg>
        </button>
        <button
          v-if="isRunning"
          @click="confirmAction = 'restart'"
          class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Restart"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
        <button
          v-if="!isRunning"
          @click="confirmAction = 'remove'"
          class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-muted hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
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
          <button class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-text-secondary hover:text-text" title="More actions" @click.stop="toggleMenu">
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
                class="kebab-menu-item flex items-center gap-2.5 px-3 py-2 text-sm text-text transition no-underline"
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
    <div v-if="expanded" class="px-2 sm:px-4 pb-4 pt-2 border-t border-border ml-2 sm:ml-10 space-y-3 text-sm">
      <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <template v-if="container.image">
          <span class="text-muted shrink-0">Image</span>
          <span class="text-text-secondary font-mono truncate">
            <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="inline-flex items-center gap-1 hover:underline" @click.stop><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>{{ container.image }}</a>
            <span v-else>{{ container.image }}</span>
          </span>
        </template>
      </div>
      <div v-if="networkInfo || displayPorts.length || displayMounts.length" class="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
        <div v-if="networkInfo || displayPorts.length">
          <p class="text-muted text-xs mb-1">Network{{ displayPorts.length ? ' / Ports' : '' }}</p>
          <div class="text-text-secondary font-mono text-xs space-y-0.5">
            <p v-if="networkInfo" class="truncate">{{ networkInfo.name }} {{ networkInfo.ip }}</p>
            <p v-for="port in displayPorts" :key="port" class="truncate">{{ port }}</p>
          </div>
        </div>
        <div v-if="displayMounts.length">
          <p class="text-muted text-xs mb-1">Volumes</p>
          <div class="text-text-secondary font-mono text-xs space-y-0.5 overflow-x-auto">
            <p v-for="mount in displayMounts" :key="mount.destination" class="whitespace-nowrap" :title="`${mount.source} -> ${mount.destination}`">
              <a :href="`/Shares/Browse?dir=${encodeURIComponent(mount.source)}`" class="inline-flex items-center gap-1 hover:underline" @click.stop><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>{{ mount.sourceShort }}</a> -&gt; {{ mount.destination }}
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
          <div class="w-full h-1.5 stats-bar-track rounded-full overflow-hidden">
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
          <div class="w-full h-1.5 stats-bar-track rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="memBarColor"
              :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"
            ></div>
          </div>
        </div>
        <!-- Detailed Stats + Container Info -->
        <div class="grid grid-cols-2 gap-4 text-xs pt-0.5">
          <!-- Left column: I/O, Network, PIDs etc -->
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 content-start">
            <span class="text-muted">Block I/O</span>
            <span class="text-text-secondary font-mono truncate">R: {{ formatBytes(containerStats.blockRead) }} / W: {{ formatBytes(containerStats.blockWrite) }}</span>
            <span class="text-muted">Network</span>
            <span class="text-text-secondary font-mono truncate">RX: {{ formatBytes(containerStats.netRx) }} / TX: {{ formatBytes(containerStats.netTx) }}</span>
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
          <!-- Right column: Health, Command, Labels -->
          <div class="space-y-2 min-w-0 content-start">
            <div v-if="healthStatus || container.command" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <template v-if="healthStatus">
                <span class="text-muted">Health</span>
                <span class="font-mono" :class="healthClass">{{ healthStatus }}</span>
              </template>
              <template v-if="container.command">
                <span class="text-muted">Command</span>
                <span class="text-text-secondary font-mono truncate" :title="container.command">{{ container.command }}</span>
              </template>
            </div>
            <div v-if="displayLabels.length" class="space-y-1">
              <p class="text-muted text-xs">Labels</p>
              <div class="text-text-secondary font-mono space-y-0.5 min-w-0 overflow-x-auto">
                <p v-for="label in displayLabels" :key="label.key" class="text-[11px] whitespace-nowrap" :title="`${label.key}=${label.value}`">
                  <span class="text-text">{{ label.key }}</span>=<span class="text-text-secondary">{{ label.value }}</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- Container info when not running (no stats section) -->
      <div v-else class="space-y-2 pt-2 border-t border-border">
        <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <template v-if="healthStatus">
            <span class="text-muted">Health</span>
            <span class="font-mono" :class="healthClass">{{ healthStatus }}</span>
          </template>
          <template v-if="container.command">
            <span class="text-muted">Command</span>
            <span class="text-text-secondary font-mono truncate" :title="container.command">{{ container.command }}</span>
          </template>
        </div>
        <div v-if="displayLabels.length" class="space-y-1 pt-1">
          <p class="text-muted text-xs">Labels</p>
          <div class="text-text-secondary font-mono space-y-0.5 min-w-0 overflow-x-auto">
            <p v-for="label in displayLabels" :key="label.key" class="text-[11px] whitespace-nowrap" :title="`${label.key}=${label.value}`">
              <span class="text-text">{{ label.key }}</span>=<span class="text-text-secondary">{{ label.value }}</span>
            </p>
          </div>
        </div>
        <div v-if="!isRunning && !container.command && !healthStatus && !displayLabels.length" class="text-muted text-xs italic">Container not running</div>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <ConfirmModal
      :is-open="!!confirmAction"
      :title="confirmModalConfig.title"
      :message="confirmModalConfig.message"
      :confirm-label="confirmModalConfig.label"
      :variant="confirmModalConfig.variant"
      @confirm="handleConfirm"
      @cancel="confirmAction = null"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, onMounted, onUnmounted, type Ref } from 'vue';
import type { Container } from '@/stores/docker';
import { useStatsStore } from '@/stores/stats';
import { useSettingsStore } from '@/stores/settings';
import { formatBytes, formatPercent, formatUptime } from '@/utils/format';
import ConfirmModal from '@/components/ConfirmModal.vue';
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

const confirmAction = ref<'stop' | 'restart' | 'remove' | null>(null);

const confirmModalConfig = computed(() => {
  switch (confirmAction.value) {
    case 'stop':
      return { title: 'Stop Container', message: `Stop "${props.container.name}"?`, label: 'Stop', variant: 'danger' as const };
    case 'restart':
      return { title: 'Restart Container', message: `Restart "${props.container.name}"?`, label: 'Restart', variant: 'default' as const };
    case 'remove':
      return { title: 'Remove Container', message: `Remove "${props.container.name}"? This cannot be undone.`, label: 'Remove', variant: 'danger' as const };
    default:
      return { title: '', message: '', label: '', variant: 'default' as const };
  }
});

function handleConfirm() {
  const action = confirmAction.value;
  confirmAction.value = null;
  if (action === 'stop') emit('stop', props.container.id);
  else if (action === 'restart') emit('restart', props.container.id);
  else if (action === 'remove') emit('remove', props.container.id);
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

// State change pulse animation
const stateChangePulse = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | undefined;

watch(() => props.container.state, () => {
  stateChangePulse.value = true;
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => { stateChangePulse.value = false; }, 600);
});

onUnmounted(() => clearTimeout(pulseTimer));

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
const dragLocked = inject<Ref<boolean>>('dragLocked', ref(false));

const isHealthy = computed(() => props.container.status?.toLowerCase().includes('(healthy)'));

const statusDotClass = computed(() => {
  const state = props.container.state;
  if (state === 'running' && distinguishHealthy.value && isHealthy.value) return 'bg-green-500';
  if (state === 'running' && distinguishHealthy.value) return 'bg-blue-500';
  if (state === 'running') return 'bg-green-500';
  if (state === 'exited' || state === 'stopped') return 'bg-red-500';
  return 'bg-gray-400';
});

// Vertical bar variant for list view (same color logic)
const statusBarClass = computed(() => statusDotClass.value);

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
  return `/logterminal/${encodeURIComponent(props.container.name)}/`;
});

const logsUrl = computed(() => {
  return `/logterminal/${encodeURIComponent(props.container.name)}.log/`;
});

const isCompose = computed(() => !!props.container.labels?.['com.docker.compose.project']);

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
  { label: 'Edit', icon: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z', href: editUrl.value || '', show: !!editUrl.value },
  { label: 'WebUI', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z', href: resolvedWebui.value || '', target: '_blank', show: !!resolvedWebui.value && isRunning.value },
  { label: 'Console', icon: 'M4 17l6-5-6-5|M12 19h8', href: consoleUrl.value, target: '_blank', show: isRunning.value && !isCompose.value },
  { label: 'Logs', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8', href: logsUrl.value, target: '_blank', show: !isCompose.value },
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

const compactPorts = computed(() => {
  const ports = props.container.ports;
  if (!ports?.length) return '';
  return ports
    .filter((p) => p.PublicPort)
    .slice(0, 3)
    .map((p) => String(p.PublicPort))
    .join(', ');
});

const displayMounts = computed(() => {
  const mounts = props.container.mounts;
  if (!mounts?.length) return [];
  return mounts.slice(0, 2).map((m) => {
    const srcShort = m.Source.length > 30 ? '...' + m.Source.slice(-27) : m.Source;
    return { destination: m.Destination, source: m.Source, sourceShort: srcShort };
  });
});

const healthStatus = computed(() => {
  const status = props.container.status?.toLowerCase() || '';
  if (status.includes('(healthy)')) return 'healthy';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  if (status.includes('(health: starting)')) return 'starting';
  return null;
});

const healthClass = computed(() => {
  switch (healthStatus.value) {
    case 'healthy': return 'text-success';
    case 'unhealthy': return 'text-error';
    case 'starting': return 'text-warning';
    default: return 'text-text-secondary';
  }
});

const displayLabels = computed(() => {
  const labels = props.container.labels;
  if (!labels) return [];
  // Filter out internal/noisy labels
  const hidden = new Set([
    'maintainer',
    'org.opencontainers.image.created',
    'org.opencontainers.image.revision',
    'org.opencontainers.image.source',
    'org.opencontainers.image.version',
  ]);
  return Object.entries(labels)
    .filter(([key]) => !hidden.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 15)
    .map(([key, value]) => ({ key, value }));
});
</script>
