import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ContainerDetails from '../ContainerDetails.vue';
import { makeContainer, makeContainerStats } from '@/test/fixtures';
import { useSettingsStore } from '@/stores/settings';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Issue 29: a container capped at 4 GB on a 32 GB host. */
const stats = makeContainerStats({
  memoryUsage: 952.4 * MB,
  memoryLimit: 4 * GB,
  memoryPercent: 23.25,
  hostMemory: 32 * GB,
});

function mountDetails(basis: 'limit' | 'host') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().memoryPercentBasis = basis;
  return mount(ContainerDetails, {
    props: {
      container: makeContainer(),
      containerStats: stats,
      showStats: true,
      isRunning: true,
      imageLink: null,
      showLogs: false,
      logLines: [],
      logError: '',
      logsLoading: false,
      newLineCount: 0,
    },
    global: { plugins: [pinia] },
  });
}

describe('ContainerDetails memory basis', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('shows the percent of the limit, labelled, by default', () => {
    const wrapper = mountDetails('limit');
    expect(wrapper.text()).toContain('952.4 MB / 4.0 GB (23.3% of limit)');
    const row = wrapper.findAll('[title]').find((el) => el.attributes('title')?.includes('container limit'));
    expect(row?.attributes('title')).toBe('952.4 MB of the 4.0 GB container limit.');
  });

  it('shows the percent of host memory on the host basis, with the real limit still in the text', () => {
    const wrapper = mountDetails('host');
    expect(wrapper.text()).toContain('952.4 MB / 4.0 GB (2.9% of host)');
    const row = wrapper.findAll('[title]').find((el) => el.attributes('title')?.includes('host memory'));
    expect(row?.attributes('title')).toContain('952.4 MB of 32.0 GB host memory');
  });
});
