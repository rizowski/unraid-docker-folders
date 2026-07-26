import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ContainerDetails from '../ContainerDetails.vue';
import { makeContainer } from '@/test/fixtures';
import { useScheduleStore } from '@/stores/schedules';
import type { Schedule } from '@/types/schedule';

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

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 1,
    name: 'Nightly backup',
    target_type: 'container',
    target_id: 'test-container',
    action: 'backup',
    cron_expression: '0 3 * * *',
    enabled: true,
    backup_config: null,
    last_run_at: null,
    last_run_status: null,
    last_run_message: null,
    next_run_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

/**
 * The schedule section reads the store rather than props, so these mount with a
 * pinia we hold onto — seeding the `beforeEach` instance would be seeding a
 * different store than the one the component resolves through the app.
 */
function mountWithSchedules(schedules: Schedule[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useScheduleStore();
  store.schedules = schedules;

  // BaseModal teleports to the app root rather than to body, so that node has
  // to exist before any modal in this section can render.
  if (!document.getElementById('unraid-docker-folders-modern')) {
    const root = document.createElement('div');
    root.id = 'unraid-docker-folders-modern';
    document.body.appendChild(root);
  }

  const wrapper = mount(ContainerDetails, {
    props: {
      container: makeContainer(),
      containerStats: null,
      showStats: false,
      isRunning: true,
      imageLink: null,
      showLogs: false,
    },
    global: { plugins: [pinia] },
  });

  return { wrapper, store };
}

/** The section's action buttons are plain text, so find them by label. */
function button(wrapper: ReturnType<typeof mountWithSchedules>['wrapper'], label: string) {
  return wrapper.findAll('button').find((b) => b.text() === label);
}

async function enterManage(wrapper: ReturnType<typeof mountWithSchedules>['wrapper']) {
  await button(wrapper, 'Manage')!.trigger('click');
}

describe('ContainerDetails schedules', () => {
  it('renders nothing when the container has no schedules', () => {
    const { wrapper } = mountWithSchedules([]);

    expect(wrapper.text()).not.toContain('Schedules');
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });

  it('shows the action, name and a relative next run', () => {
    const eightHoursOut = Math.floor(Date.now() / 1000) + 8 * 3600 + 60;
    const { wrapper } = mountWithSchedules([makeSchedule({ next_run_at: eightHoursOut })]);

    expect(wrapper.text()).toContain('Schedules');
    expect(wrapper.text()).toContain('Nightly backup');
    expect(wrapper.text()).toContain('backup');
    // Relative, not an absolute timestamp.
    expect(wrapper.findAll('span').some((s) => /^in \d/.test(s.text()))).toBe(true);
    expect(wrapper.text()).not.toContain('0 3 * * *');
  });

  it('ignores schedules belonging to a different container', () => {
    // The join key is the container NAME, so a near-miss must not leak in.
    const { wrapper } = mountWithSchedules([
      makeSchedule({ id: 2, name: 'Someone elses job', target_id: 'other-container' }),
    ]);

    expect(wrapper.text()).not.toContain('Someone elses job');
    expect(wrapper.text()).not.toContain('Schedules');
  });

  it('ignores stack schedules that happen to share the name', () => {
    const { wrapper } = mountWithSchedules([
      makeSchedule({ id: 3, name: 'Stack job', target_type: 'stack' }),
    ]);

    expect(wrapper.text()).not.toContain('Stack job');
  });

  it('says "disabled" instead of a next run time when disabled', () => {
    // next_run_at stays populated on a disabled schedule; showing it would read
    // as still-armed.
    const { wrapper } = mountWithSchedules([
      makeSchedule({ enabled: false, next_run_at: 4102444800 }),
    ]);

    expect(wrapper.findAll('span').some((s) => s.text() === 'disabled')).toBe(true);
    expect(wrapper.text()).not.toContain('next');
  });

  it('colors a failed last run with the error token', () => {
    const { wrapper } = mountWithSchedules([makeSchedule({ last_run_status: 'error' })]);

    const statusEl = wrapper.findAll('span').find((s) => s.text() === 'error');
    expect(statusEl).toBeTruthy();
    expect(statusEl!.classes()).toContain('text-error');
  });
});

/** Teleported modal markup outlives its wrapper, so clear it between tests. */
function confirmButton() {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete');
}

describe('ContainerDetails schedules manage mode', () => {
  beforeEach(() => {
    document.getElementById('unraid-docker-folders-modern')?.replaceChildren();
  });

  it('locks the checkbox and hides edit/delete until Manage is clicked', async () => {
    const { wrapper } = mountWithSchedules([makeSchedule()]);

    expect(wrapper.find('input[type="checkbox"]').attributes('disabled')).toBeDefined();
    expect(button(wrapper, 'Manage')).toBeTruthy();
    expect(wrapper.find('[aria-label="Edit Nightly backup"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Delete Nightly backup"]').exists()).toBe(false);

    await enterManage(wrapper);

    expect(wrapper.find('input[type="checkbox"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[aria-label="Edit Nightly backup"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Delete Nightly backup"]').exists()).toBe(true);
  });

  it('stages a toggle without calling the API until Done', async () => {
    const { wrapper, store } = mountWithSchedules([makeSchedule({ id: 7, enabled: true })]);
    const bulk = vi.spyOn(store, 'bulkSetEnabled').mockResolvedValue({ success: true });

    await enterManage(wrapper);
    await wrapper.find('input[type="checkbox"]').setValue(false);

    // Staged only — the row reads as disabled but nothing has been sent.
    expect(bulk).not.toHaveBeenCalled();
    expect(wrapper.findAll('span').some((s) => s.text() === 'disabled')).toBe(true);

    await button(wrapper, 'Done')!.trigger('click');

    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledWith([{ id: 7, enabled: false }]);
  });

  it('sends one bulk call covering changes in both directions', async () => {
    const { wrapper, store } = mountWithSchedules([
      makeSchedule({ id: 1, name: 'A', enabled: true }),
      makeSchedule({ id: 2, name: 'B', enabled: false }),
    ]);
    const bulk = vi.spyOn(store, 'bulkSetEnabled').mockResolvedValue({ success: true });

    await enterManage(wrapper);
    const boxes = wrapper.findAll('input[type="checkbox"]');
    await boxes[0].setValue(false);
    await boxes[1].setValue(true);
    await button(wrapper, 'Done')!.trigger('click');

    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledWith([
      { id: 1, enabled: false },
      { id: 2, enabled: true },
    ]);
  });

  it('sends nothing when a row is toggled back to its original value', async () => {
    const { wrapper, store } = mountWithSchedules([makeSchedule({ id: 7, enabled: true })]);
    const bulk = vi.spyOn(store, 'bulkSetEnabled').mockResolvedValue({ success: true });

    await enterManage(wrapper);
    const box = wrapper.find('input[type="checkbox"]');
    await box.setValue(false);
    await box.setValue(true);
    await button(wrapper, 'Done')!.trigger('click');

    expect(bulk).not.toHaveBeenCalled();
  });

  it('discards staged changes on Cancel', async () => {
    const { wrapper, store } = mountWithSchedules([makeSchedule({ id: 7, enabled: true })]);
    const bulk = vi.spyOn(store, 'bulkSetEnabled').mockResolvedValue({ success: true });

    await enterManage(wrapper);
    await wrapper.find('input[type="checkbox"]').setValue(false);
    await button(wrapper, 'Cancel')!.trigger('click');

    expect(bulk).not.toHaveBeenCalled();
    // Back to the server value, and locked again.
    expect(wrapper.findAll('span').some((s) => s.text() === 'disabled')).toBe(false);
    expect(wrapper.find('input[type="checkbox"]').attributes('disabled')).toBeDefined();
  });

  it('requires confirmation before deleting, then sends one bulk delete', async () => {
    const { wrapper, store } = mountWithSchedules([
      makeSchedule({ id: 1, name: 'A' }),
      makeSchedule({ id: 2, name: 'B' }),
    ]);
    const del = vi.spyOn(store, 'bulkDelete').mockResolvedValue({ success: true });

    await enterManage(wrapper);
    await wrapper.find('[aria-label="Delete A"]').trigger('click');
    await wrapper.find('[aria-label="Delete B"]').trigger('click');

    // No confirmation is showing while the deletes are merely staged.
    expect(confirmButton()).toBeUndefined();

    await button(wrapper, 'Done')!.trigger('click');

    // Done alone must not delete — the confirmation is the gate.
    expect(del).not.toHaveBeenCalled();

    const confirmBtn = confirmButton();
    expect(confirmBtn).toBeTruthy();
    confirmBtn!.click();
    await nextTick();

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith([1, 2]);
  });

  it('excludes a row staged for deletion from the enable update', async () => {
    const { wrapper, store } = mountWithSchedules([makeSchedule({ id: 9, name: 'A', enabled: true })]);
    const bulk = vi.spyOn(store, 'bulkSetEnabled').mockResolvedValue({ success: true });
    vi.spyOn(store, 'bulkDelete').mockResolvedValue({ success: true });

    await enterManage(wrapper);
    await wrapper.find('input[type="checkbox"]').setValue(false);
    await wrapper.find('[aria-label="Delete A"]').trigger('click');
    await button(wrapper, 'Done')!.trigger('click');

    confirmButton()!.click();
    await nextTick();

    expect(bulk).not.toHaveBeenCalled();
  });

  it('surfaces a failed bulk update instead of silently exiting', async () => {
    const { wrapper, store } = mountWithSchedules([makeSchedule({ id: 7, enabled: true })]);
    vi.spyOn(store, 'bulkSetEnabled').mockResolvedValue({ success: false, error: 'HTTP 500' });

    await enterManage(wrapper);
    await wrapper.find('input[type="checkbox"]').setValue(false);
    await button(wrapper, 'Done')!.trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('HTTP 500');
    // Still in manage mode so the staged changes aren't lost.
    expect(button(wrapper, 'Done')).toBeTruthy();
  });
});
