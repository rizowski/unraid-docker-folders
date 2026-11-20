import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import StackRemoveConfirmModal from '../StackRemoveConfirmModal.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import { useComposeStore } from '@/stores/compose';
import { useDockerStore } from '@/stores/docker';
import { makeContainer } from '@/test/fixtures';
import type { ComposeStack } from '@/types/compose';

function makeStack(project_name: string, own_files?: boolean): ComposeStack {
  return {
    project_name,
    working_dir: null,
    own_files,
    compose_file: null,
    env_file: null,
    autostart: false,
    autostart_force_recreate: false,
    description: null,
    imported_from: null,
    services_running: 0,
    services_total: 0,
  };
}

let pinia: Pinia;

function mountModal(project = 'immich') {
  const wrapper = mount(StackRemoveConfirmModal, { props: { project }, global: { plugins: [pinia], stubs: { teleport: true } } });
  return wrapper.findComponent(ConfirmModal).props();
}

describe('StackRemoveConfirmModal', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it('says in short sentences what goes and what stays', () => {
    useComposeStore().stacks = [makeStack('immich')];
    expect(mountModal().message).toBe(
      'Remove "immich" from Docker Folders? Its schedules and its folder are removed too. Containers and compose files are not changed.',
    );
  });

  it('offers the delete-files box only for a stack in the plugin own folder', () => {
    useComposeStore().stacks = [makeStack('immich', true)];
    const props = mountModal();
    expect(props.checkboxLabel).toBeTruthy();
    expect(props.message).toContain('not changed unless you tick the box');
  });

  it('has no delete-files box for any other stack', () => {
    useComposeStore().stacks = [makeStack('immich', false), makeStack('plain')];
    expect(mountModal('immich').checkboxLabel).toBeUndefined();
    expect(mountModal('plain').checkboxLabel).toBeUndefined();
  });

  it('tells the user to run Stack Down first while containers exist', () => {
    useComposeStore().stacks = [makeStack('immich')];
    useDockerStore().containers = [
      makeContainer({ id: 'a', name: 'web', labels: { 'com.docker.compose.project': 'immich' } }),
    ];
    expect(mountModal().message).toContain('Run Stack Down first.');
  });
});
