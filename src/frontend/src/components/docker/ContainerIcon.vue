<template>
  <component
    :is="href ? 'a' : 'span'"
    v-bind="linkAttrs"
    class="shrink-0 flex p-0.5 status-halo"
    :class="[haloClass, href ? 'cursor-pointer' : '']"
    :title="title"
    @click="onClick"
  >
    <img
      :src="src"
      :alt="alt"
      class="w-7 h-7 object-contain"
      :class="href ? 'transition-opacity hover:opacity-75' : ''"
    />
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';

/**
 * The container's icon, wrapped in the state halo. Becomes a link to the
 * container's WebUI when it has one; otherwise it's an inert span so the click
 * bubbles up and toggles the card like the rest of the card head.
 */
const props = defineProps<{
  src: string;
  alt: string;
  /** Halo state class, e.g. `status-halo-success`. */
  haloClass: string;
  statusTooltip: string;
  /** Resolved WebUI URL, or null when there isn't one. */
  href: string | null;
}>();

// A real anchor rather than a click handler, so middle- and ctrl-click open a
// background tab natively.
const linkAttrs = computed(() =>
  props.href
    ? { href: props.href, target: '_blank', rel: 'noopener noreferrer' }
    : {},
);

const title = computed(() =>
  props.href ? `Open WebUI · ${props.statusTooltip}` : props.statusTooltip,
);

// `.stop` can't be conditional, and stopping unconditionally would break
// click-to-expand for the majority of containers that have no WebUI.
function onClick(event: MouseEvent) {
  if (props.href) event.stopPropagation();
}
</script>
