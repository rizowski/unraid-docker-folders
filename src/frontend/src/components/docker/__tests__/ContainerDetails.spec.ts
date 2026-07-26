import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ContainerDetails from '../ContainerDetails.vue';
import { makeContainer } from '@/test/fixtures';

/**
 * ContainerDetails is pure props, so the log pane's render branches can be
 * driven directly — no fetch mock and none of ContainerCard's four
 * preconditions for inline logs.
 */
function mountDetails(props: Record<string, unknown> = {}) {
  return mount(ContainerDetails, {
    props: {
      container: makeContainer(),
      containerStats: null,
      showStats: false,
      isRunning: true,
      imageLink: null,
      showLogs: true,
      logLines: [],
      logError: '',
      logsLoading: false,
      newLineCount: 0,
      ...props,
    },
    global: { plugins: [createPinia()] },
  });
}

describe('ContainerDetails log pane', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders log lines when there are any', () => {
    const wrapper = mountDetails({ logLines: ['2026-07-25 12:00:00 ready', '2026-07-25 11:59:59 booting'] });

    expect(wrapper.text()).toContain('ready');
    expect(wrapper.text()).toContain('booting');
    expect(wrapper.text()).not.toContain('No logs available.');
  });

  it('shows the empty state when the container is simply quiet', () => {
    const wrapper = mountDetails({ logLines: [], logError: '' });

    expect(wrapper.text()).toContain('No logs available.');
  });

  it('shows the error instead of the empty state when Docker refused', () => {
    // These two must never look the same: one means "quiet", the other means
    // "we could not read them, here is why".
    const wrapper = mountDetails({
      logLines: [],
      logError: "Docker API HTTP 400 — this container's logging driver may not support reading logs",
    });

    expect(wrapper.text()).toContain('logging driver may not support reading logs');
    expect(wrapper.text()).not.toContain('No logs available.');
  });

  it('styles the error with the error token, not the muted one', () => {
    const wrapper = mountDetails({ logLines: [], logError: 'Failed to load logs.' });

    const errorEl = wrapper.findAll('span').find((s) => s.text() === 'Failed to load logs.');
    expect(errorEl).toBeTruthy();
    expect(errorEl!.classes()).toContain('text-error');
  });

  it('prefers the loading state over both', () => {
    const wrapper = mountDetails({ logLines: [], logError: 'stale error', logsLoading: true });

    expect(wrapper.text()).toContain('Loading logs...');
    expect(wrapper.text()).not.toContain('stale error');
  });
});
