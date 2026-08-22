<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="560px" @close="$emit('cancel')">
    <div class="px-6 py-4 border-b border-border">
      <h2 class="text-base font-semibold text-text">Adopt {{ containerName }} into Unraid</h2>
      <p class="text-sm text-text-secondary mt-1">
        Unraid takes over this container so you can edit it in the Docker tab.
      </p>
    </div>

    <div class="max-h-[420px] overflow-auto px-6 py-4">
      <p v-if="error" class="text-sm text-error">{{ error }}</p>

      <p v-else-if="!data" class="text-sm text-text-secondary">Reading the container…</p>

      <template v-else>
        <p class="text-sm text-text-secondary">{{ benefitsText }}</p>

        <p class="mt-3 text-sm text-warning">{{ warningText }}</p>

        <dl class="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
          <template v-for="row in rows" :key="row.label">
            <dt class="text-xs uppercase tracking-wide text-text-secondary pt-0.5">{{ row.label }}</dt>
            <dd class="text-sm text-text font-mono break-all">{{ row.value }}</dd>
          </template>
        </dl>

        <p v-if="!data.portsPublished && hasPorts" class="mt-4 text-sm text-warning">
          {{ portsNote }}
        </p>

        <p v-if="!data.imageEnvKnown" class="mt-4 text-sm text-warning">
          The image could not be read, so the variables above may include values
          that came from the image rather than from you.
        </p>

        <div v-if="data.unmapped.length" class="mt-4">
          <p class="text-sm text-warning">These settings have no Unraid field:</p>
          <ul class="mt-1 list-disc pl-5">
            <li v-for="item in data.unmapped" :key="item" class="text-sm text-text-secondary">{{ item }}</li>
          </ul>
        </div>
      </template>
    </div>

    <div class="flex items-center gap-2 px-6 py-3 border-t border-border">
      <button
        type="button"
        class="nav-btn"
        :class="{ 'opacity-50 cursor-not-allowed': !data }"
        :disabled="!data"
        title="Ask Unraid what it would run, without changing anything"
        @click="$emit('dry-run')"
      >Dry Run</button>
      <span class="flex-1"></span>
      <button type="button" class="nav-btn" @click="$emit('cancel')">Cancel</button>
      <button
        ref="confirmBtn"
        type="button"
        class="nav-btn warning"
        :class="{ 'opacity-50 cursor-not-allowed': !data }"
        :disabled="!data"
        @click="$emit('adopt')"
      >Adopt</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useParentModal, type ModalField } from '@/composables/useParentModal';
import type { AdoptFields } from '@/utils/unraidHandoff';

interface Props {
  isOpen: boolean;
  containerName: string;
  /** Null while the field set is still being fetched. */
  data: AdoptFields | null;
  error?: string | null;
  /** A stopped container comes back running — see warningText. */
  isRunning?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  error: null,
  isRunning: true,
});

const emit = defineEmits<{
  adopt: [];
  'dry-run': [];
  cancel: [];
}>();

const confirmBtn = ref<HTMLButtonElement | null>(null);

/** Configs of one Type, in the order the builder emitted them. */
function ofType(type: string) {
  return (props.data?.configs ?? []).filter((c) => c.Type === type);
}

const hasPorts = computed(() => ofType('Port').length > 0);

/** Why a user would want this. The modal states the cost as well — see warningText. */
const benefitsText =
  'After adoption Unraid manages this container. You get the Edit form in the Docker tab, '
  + 'autostart control, and a template you can reuse.';

/**
 * A stopped container does not stay stopped. CreateDocker.php sets
 * $startContainer = true and only clears it in a rename branch that this flow
 * never reaches, so `docker create` becomes `docker run -d`.
 */
const warningText = computed(() => {
  const base = 'Unraid removes and recreates this container. Anything written outside a mount is lost.';
  return props.isRunning ? base : `${base} This container is stopped, and it will be started.`;
});

/**
 * On host, macvlan and ipvlan networks Unraid emits no -p at all. It passes the
 * host port as a TCP_PORT_n / UDP_PORT_n variable and the container answers on
 * its own address instead. Confirmed against Unraid's own xmlToCommand.
 */
const portsNote = computed(() => {
  const driver = props.data?.networkDriver || 'this';
  return `On a ${driver} network Unraid does not publish ports. It passes them as TCP_PORT / UDP_PORT variables, and the container answers on its own address.`;
});

const rows = computed(() => {
  const data = props.data;
  if (!data) return [];

  const out: { label: string; value: string }[] = [
    { label: 'Image', value: data.fields.contRepository || '—' },
    { label: 'Network', value: data.fields.contNetwork || '—' },
  ];

  const ports = ofType('Port').map((c) => `${c.Value}→${c.Target}/${c.Mode}`);
  if (ports.length) out.push({ label: 'Ports', value: ports.join('  ') });

  const paths = ofType('Path').map((c) => `${c.Value} → ${c.Target} (${c.Mode})`);
  if (paths.length) out.push({ label: 'Paths', value: paths.join('\n') });

  // Values are deliberately not shown. One of them may be a password, and the
  // point of Mask is that it does not get displayed.
  const vars = ofType('Variable').map((c) => (c.Mask === 'true' ? `${c.Target} (hidden)` : c.Target));
  if (vars.length) out.push({ label: 'Variables', value: vars.join('  ') });

  const labels = ofType('Label').map((c) => c.Target);
  if (labels.length) out.push({ label: 'Labels', value: labels.join('  ') });

  const devices = ofType('Device').map((c) => c.Value);
  if (devices.length) out.push({ label: 'Devices', value: devices.join('  ') });

  if (data.fields.contExtraParams) {
    out.push({ label: 'Extra', value: data.fields.contExtraParams });
  }
  if (data.fields.contPostArgs) {
    out.push({ label: 'Command', value: data.fields.contPostArgs });
  }

  return out;
});

const parentModal = useParentModal({
  onAction({ actionId }) {
    if (actionId === 'adopt') emit('adopt');
    else if (actionId === 'dry-run') emit('dry-run');
    else emit('cancel');
  },
});

const { inIframe } = parentModal;

/**
 * The host renders a flat field list, so the same content is expressed as
 * heading/text fields rather than the grid above.
 */
function parentFields(): ModalField[] {
  const data = props.data;
  if (props.error) return [{ type: 'text', text: props.error, variant: 'error' }];
  if (!data) return [{ type: 'text', text: 'Reading the container…', variant: 'muted' }];

  const fields: ModalField[] = [
    { type: 'text', text: benefitsText, variant: 'muted' },
    { type: 'text', text: warningText.value, variant: 'error' },
  ];

  for (const row of rows.value) {
    fields.push({ type: 'heading', text: row.label });
    fields.push({ type: 'text', text: row.value, variant: 'muted' });
  }

  if (!data.portsPublished && hasPorts.value) {
    fields.push({ type: 'text', text: portsNote.value, variant: 'error' });
  }

  if (!data.imageEnvKnown) {
    fields.push({
      type: 'text',
      text: 'The image could not be read, so the variables above may include values that came from the image rather than from you.',
      variant: 'error',
    });
  }

  if (data.unmapped.length) {
    fields.push({ type: 'heading', text: 'No Unraid field' });
    for (const item of data.unmapped) {
      fields.push({ type: 'text', text: item, variant: 'muted' });
    }
  }

  return fields;
}

function parentDescriptor() {
  return {
    kind: 'adopt' as const,
    title: `Adopt ${props.containerName} into Unraid`,
    size: 'md' as const,
    fields: parentFields(),
    actions: [
      { id: 'dry-run', label: 'Dry Run', variant: 'default' as const, disabled: !props.data },
      { id: 'cancel', label: 'Cancel', variant: 'default' as const },
      { id: 'adopt', label: 'Adopt', variant: 'danger' as const, disabled: !props.data },
    ],
  };
}

watch(
  () => [props.isOpen, props.data, props.error] as const,
  ([open]) => {
    if (inIframe) {
      // Re-opened rather than patched when the fetch lands: update() can only
      // change a field it can address by id, so it cannot swap a single loading
      // line for the whole summary.
      if (open) parentModal.open(parentDescriptor());
      else parentModal.close();
      return;
    }
    if (open) nextTick(() => confirmBtn.value?.focus());
  },
  { immediate: true },
);
</script>
