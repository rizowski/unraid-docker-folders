<template>
  <!-- Placeholder folders and containers while the first load runs. Shapes
       follow FolderHeader and ContainerCard, so the page does not jump when
       the data arrives. -->
  <div role="status" aria-busy="true" class="loading-skeleton">
    <span class="sr-only">Loading...</span>
    <div v-for="folder in FOLDERS" :key="folder.name" class="mb-2">
      <div class="flex items-center gap-2 px-3 py-3 sm:px-6 sm:py-4 bg-bg-card rounded-sm">
        <span class="skeleton size-4 shrink-0" />
        <span class="skeleton h-4" :style="{ width: folder.name }" />
        <span class="skeleton h-4 w-6 rounded-full!" />
        <span class="flex-1" />
        <span class="skeleton hidden sm:block h-2 w-24" />
        <span class="skeleton hidden sm:block h-2 w-24" />
      </div>

      <div
        v-if="folder.containers > 0"
        class="mt-2 mb-4"
        :class="view === 'list' ? 'flex flex-col gap-2' : 'grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-4'"
      >
        <template v-if="view === 'list'">
          <div
            v-for="n in folder.containers"
            :key="n"
            class="flex items-center gap-3 px-3 py-2 border border-border/50 rounded bg-bg-card"
          >
            <span class="skeleton size-8 shrink-0 rounded-full!" />
            <span class="skeleton h-3.5" :style="{ width: nameWidth(n) }" />
            <span class="flex-1" />
            <span class="skeleton hidden sm:block h-2 w-20" />
            <span class="skeleton hidden sm:block h-2 w-20" />
          </div>
        </template>
        <template v-else>
          <div
            v-for="n in folder.containers"
            :key="n"
            class="flex flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6 border border-border/50 rounded-lg bg-bg-card"
          >
            <div class="flex items-center gap-2">
              <span class="skeleton size-10 shrink-0 rounded-full!" />
              <span class="flex flex-col gap-1.5 flex-1 min-w-0">
                <span class="skeleton h-3.5" :style="{ width: nameWidth(n) }" />
                <span class="skeleton h-2.5 w-1/3" />
              </span>
            </div>
            <span class="skeleton h-2 w-full" />
            <span class="skeleton h-2 w-full" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ view: 'grid' | 'list' }>();

/** Three folders, the first open. Name widths vary so the rows do not look stamped. */
const FOLDERS = [
  { name: '8rem', containers: 3 },
  { name: '6rem', containers: 0 },
  { name: '10rem', containers: 0 },
];

const NAME_WIDTHS = ['55%', '40%', '65%'];
function nameWidth(n: number): string {
  return NAME_WIDTHS[(n - 1) % NAME_WIDTHS.length];
}
</script>
