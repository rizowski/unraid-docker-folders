import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import AdoptModal from '../AdoptModal.vue';
import type { AdoptConfig, AdoptFields } from '@/utils/unraidHandoff';

function config(overrides: Partial<AdoptConfig> = {}): AdoptConfig {
  return {
    Name: 'Port 80',
    Target: '80',
    Default: '18081',
    Mode: 'tcp',
    Description: '',
    Type: 'Port',
    Display: 'always',
    Required: 'false',
    Mask: 'false',
    Value: '18081',
    ...overrides,
  };
}

function fields(overrides: Partial<AdoptFields> = {}): AdoptFields {
  return {
    fields: {
      contName: 'Adopt2',
      contRepository: 'nginx:alpine',
      contNetwork: 'bridge',
      contExtraParams: '--restart=unless-stopped',
      contPostArgs: '',
    },
    configs: [config()],
    unmapped: [],
    imageEnvKnown: true,
    portsPublished: true,
    networkDriver: 'bridge',
    managed: null,
    ...overrides,
  };
}

// BaseModal teleports here, so the node has to exist.
let target: HTMLElement;

function mountModal(props: Partial<Record<string, unknown>> = {}) {
  return mount(AdoptModal, {
    props: {
      isOpen: true,
      containerName: 'Adopt2',
      data: fields(),
      ...props,
    },
  });
}

function bodyText(): string {
  return target.textContent ?? '';
}

describe('AdoptModal', () => {
  beforeEach(() => {
    target = document.createElement('div');
    target.id = 'unraid-docker-folders-modern';
    document.body.appendChild(target);
  });

  afterEach(() => {
    target.remove();
  });

  it('always says the container gets recreated', () => {
    mountModal();

    expect(bodyText()).toContain('removes and recreates this container');
    expect(bodyText()).toContain('outside a mount is lost');
  });

  it('warns that a stopped container will be started', () => {
    // CreateDocker.php turns `docker create` into `docker run -d` on this path,
    // so a stopped container does not stay stopped.
    mountModal({ isRunning: false });

    expect(bodyText()).toContain('it will be started');
  });

  it('does not mention starting when the container is already running', () => {
    mountModal({ isRunning: true });

    expect(bodyText()).not.toContain('it will be started');
  });

  it('summarises what will be sent', () => {
    mountModal();

    expect(bodyText()).toContain('nginx:alpine');
    expect(bodyText()).toContain('18081→80/tcp');
    expect(bodyText()).toContain('--restart=unless-stopped');
  });

  it('names a masked variable without showing its value', () => {
    mountModal({
      data: fields({
        configs: [config({ Type: 'Variable', Target: 'DB_PASSWORD', Value: 'hunter2', Mask: 'true' })],
      }),
    });

    expect(bodyText()).toContain('DB_PASSWORD');
    expect(bodyText()).not.toContain('hunter2');
  });

  it('warns when Unraid will not publish the ports', () => {
    mountModal({
      data: fields({ portsPublished: false, networkDriver: 'ipvlan' }),
    });

    expect(bodyText()).toContain('ipvlan');
    expect(bodyText()).toContain('does not publish ports');
  });

  it('stays quiet about publishing on a bridge network', () => {
    mountModal();

    expect(bodyText()).not.toContain('does not publish ports');
  });

  it('does not warn about publishing when there are no ports at all', () => {
    mountModal({
      data: fields({ portsPublished: false, networkDriver: 'host', configs: [] }),
    });

    expect(bodyText()).not.toContain('does not publish ports');
  });

  it('lists settings that could not be mapped', () => {
    mountModal({ data: fields({ unmapped: ['--tmpfs (/run)'] }) });

    expect(bodyText()).toContain('--tmpfs (/run)');
    expect(bodyText()).toContain('no Unraid field');
  });

  it('says so when the image could not be read', () => {
    mountModal({ data: fields({ imageEnvKnown: false }) });

    expect(bodyText()).toContain('image could not be read');
  });

  it('disables both actions until the field set arrives', () => {
    mountModal({ data: null });

    const buttons = Array.from(target.querySelectorAll('button'));
    const adopt = buttons.find((b) => b.textContent?.trim() === 'Adopt')!;
    const dryRun = buttons.find((b) => b.textContent?.trim() === 'Dry Run')!;

    expect(adopt.disabled).toBe(true);
    expect(dryRun.disabled).toBe(true);
    expect(bodyText()).toContain('Reading the container');
  });

  it('shows a fetch failure instead of a summary', () => {
    mountModal({ data: null, error: 'Container not found' });

    expect(bodyText()).toContain('Container not found');
  });
});

/**
 * On Unraid the modal is rendered by the parent window and the button press
 * arrives as a postMessage. Adopt is destructive, so the mapping from action id
 * to emitted event has to be exact — a stray id must never read as "adopt".
 */
describe('AdoptModal – parent-window (iframe) path', () => {
  let parentPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    target = document.createElement('div');
    target.id = 'unraid-docker-folders-modern';
    document.body.appendChild(target);

    parentPostMessage = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage: parentPostMessage },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    target.remove();
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true });
  });

  /** Descriptors this component posted upward, oldest first. */
  function opens() {
    return parentPostMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === 'docker-folders-modal' && m.open);
  }

  async function hostPresses(actionId: string) {
    const latest = opens()[opens().length - 1];
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'docker-folders-modal-action', id: latest.modal.id, actionId, values: {} },
      }),
    );
    await nextTick();
  }

  it('emits adopt only for the adopt action', async () => {
    const wrapper = mountModal();
    await hostPresses('adopt');

    expect(wrapper.emitted('adopt')).toBeTruthy();
    expect(wrapper.emitted('cancel')).toBeFalsy();
  });

  it('emits dry-run for the dry-run action', async () => {
    const wrapper = mountModal();
    await hostPresses('dry-run');

    expect(wrapper.emitted('dry-run')).toBeTruthy();
    expect(wrapper.emitted('adopt')).toBeFalsy();
  });

  it('treats every other action as a dismissal', async () => {
    const wrapper = mountModal();
    await hostPresses('cancel');

    expect(wrapper.emitted('cancel')).toBeTruthy();
    expect(wrapper.emitted('adopt')).toBeFalsy();
  });

  it('never reads an unknown action as adopt', async () => {
    const wrapper = mountModal();
    await hostPresses('something-else');

    expect(wrapper.emitted('adopt')).toBeFalsy();
    expect(wrapper.emitted('cancel')).toBeTruthy();
  });

  it('re-opens with the summary once the field set lands', async () => {
    // update() can only patch a field it can address by id, so it cannot swap
    // the loading line for the whole summary. The modal re-opens instead.
    const wrapper = mountModal({ data: null });
    expect(opens()).toHaveLength(1);
    expect(JSON.stringify(opens()[0].modal.fields)).toContain('Reading the container');

    await wrapper.setProps({ data: fields() });

    expect(opens()).toHaveLength(2);
    expect(JSON.stringify(opens()[1].modal.fields)).toContain('nginx:alpine');
  });

  it('disables the destructive action while the field set is missing', () => {
    mountModal({ data: null });

    const adopt = opens()[0].modal.actions.find((a: { id: string }) => a.id === 'adopt');
    expect(adopt.disabled).toBe(true);
  });
});
