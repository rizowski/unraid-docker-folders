<template>
  <Transition name="modal">
  <div v-if="isOpen" class="absolute inset-0 z-[1000]" :style="{ minHeight: totalHeight + 'px' }">
    <div class="absolute inset-0 bg-black/50" @click="$emit('close')"></div>
    <div class="absolute flex items-center justify-center" :style="viewportStyle" @click="$emit('close')">
      <div class="modal-content bg-bg-card rounded-lg shadow-lg flex flex-col w-[90%]" :style="{ maxWidth: maxWidth, ...heightStyle }" @click.stop>
        <slot />
      </div>
    </div>
  </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useParentViewport } from '@/composables/useParentViewport';
import { useModalElevation } from '@/composables/useModalElevation';

interface Props {
  isOpen: boolean;
  maxWidth?: string;
  fillHeight?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  maxWidth: '500px',
  fillHeight: false,
});

defineEmits<{ close: [] }>();

useModalElevation(() => props.isOpen);
const { visibleTop, visibleHeight } = useParentViewport();

const totalHeight = computed(() =>
  Math.max(document.documentElement.scrollHeight, visibleTop.value + visibleHeight.value)
);
const viewportStyle = computed(() => ({
  top: visibleTop.value + 'px',
  left: '0',
  width: '100%',
  height: visibleHeight.value + 'px',
}));

const heightStyle = computed(() =>
  props.fillHeight ? { height: '85%' } : { maxHeight: '90%', overflow: 'auto' }
);
</script>
