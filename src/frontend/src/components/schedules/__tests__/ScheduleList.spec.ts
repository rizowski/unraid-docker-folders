import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ScheduleList from '../ScheduleList.vue';
import { useScheduleStore } from '@/stores/schedules';
import type { ScheduleRunnerState } from '@/types/schedule';
import { makeSchedule } from '@/test/fixtures';

function freshRunner(overrides: Partial<ScheduleRunnerState> = {}): ScheduleRunnerState {
  return {
    last_tick: Math.floor(Date.now() / 1000) - 30,
    stale: false,
    stale_after: 300,
    cron_installed: true,
    ...overrides,
  };
}

// BaseModal teleports into #unraid-docker-folders-modern, so the markup never
// lands inside the wrapper. Every DOM assertion reads that root instead.
const APP_ROOT = 'unraid-docker-folders-modern';

function rootText(): string {
  return document.getElementById(APP_ROOT)?.textContent ?? '';
}

function rootQuery<T extends Element>(selector: string): T | null {
  return document.getElementById(APP_ROOT)?.querySelector<T>(selector) ?? null;
}

function mountList(runner: ScheduleRunnerState | null, schedules = [makeSchedule()]) {
  const store = useScheduleStore();
  store.schedules = schedules;
  store.runner = runner;
  // onMounted only fetches when the list is empty, but keep the network out
  // of every case.
  store.fetchSchedules = vi.fn().mockResolvedValue(undefined);

  const wrapper: VueWrapper = mount(ScheduleList, {
    props: { isOpen: true, targetType: 'container', targetId: 'plex' },
    attachTo: document.body,
  });

  return { wrapper, store };
}

describe('ScheduleList runner warning', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = APP_ROOT;
    document.body.appendChild(root);
  });

  it('stays quiet while the runner is ticking', () => {
    const { wrapper } = mountList(freshRunner());

    expect(rootText()).not.toContain('Scheduled actions are not running');
    wrapper.unmount();
  });

  it('warns when the heartbeat has gone stale', () => {
    const { wrapper } = mountList(freshRunner({ stale: true, last_tick: Math.floor(Date.now() / 1000) - 900 }));

    expect(rootText()).toContain('Scheduled actions are not running');
    expect(rootText()).toContain('The schedule runner last ran at');
    wrapper.unmount();
  });

  it('warns when the cron entry is missing outright', () => {
    const { wrapper } = mountList(freshRunner({ cron_installed: false, stale: true, last_tick: null }));

    expect(rootText()).toContain('The cron entry that runs schedules is missing.');
    wrapper.unmount();
  });

  it('stays quiet before the first response arrives', () => {
    // A null runner means "not known yet", not "broken". Warning here would
    // flash on every open of the modal.
    const { wrapper } = mountList(null);

    expect(rootText()).not.toContain('Scheduled actions are not running');
    wrapper.unmount();
  });

  it('reinstalls the cron entry and refetches', async () => {
    const { wrapper, store } = mountList(freshRunner({ cron_installed: false, stale: true, last_tick: null }));
    store.repairCron = vi.fn().mockResolvedValue({ success: true });

    const button = Array.from(document.getElementById(APP_ROOT)!.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('Reinstall runner'));
    expect(button).toBeTruthy();
    button!.click();
    await wrapper.vm.$nextTick();

    expect(store.repairCron).toHaveBeenCalled();
    expect(store.fetchSchedules).toHaveBeenCalledWith(true);
    wrapper.unmount();
  });
});

describe('ScheduleList Run now', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = APP_ROOT;
    document.body.appendChild(root);
  });

  it('asks before running, instead of acting on the click', async () => {
    const { wrapper, store } = mountList(freshRunner());
    store.runScheduleNow = vi.fn().mockResolvedValue({ success: true });

    rootQuery<HTMLButtonElement>('button[aria-label="Run now"]')!.click();
    await wrapper.vm.$nextTick();

    expect(store.runScheduleNow).not.toHaveBeenCalled();
    expect(rootText()).toContain('Run Schedule Now');
    expect(rootText()).toContain('This will restart container plex immediately.');
    wrapper.unmount();
  });

  it('runs the schedule once the user confirms', async () => {
    const { wrapper, store } = mountList(freshRunner());
    store.runScheduleNow = vi.fn().mockResolvedValue({ success: true });

    rootQuery<HTMLButtonElement>('button[aria-label="Run now"]')!.click();
    await wrapper.vm.$nextTick();
    const confirm = wrapper.findAllComponents({ name: 'ConfirmModal' })
      .find((c) => c.props('title') === 'Run Schedule Now');
    expect(confirm).toBeTruthy();
    confirm!.vm.$emit('confirm');
    await wrapper.vm.$nextTick();

    expect(store.runScheduleNow).toHaveBeenCalledWith(1);
    wrapper.unmount();
  });
});
