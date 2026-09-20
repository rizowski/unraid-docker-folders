import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ScheduleForm from '../ScheduleForm.vue';
import PathSuggestInput from '@/components/PathSuggestInput.vue';
import { useScheduleStore } from '@/stores/schedules';
import type { Schedule, QuiesceMode } from '@/types/schedule';
import { makeSchedule } from '@/test/fixtures';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/csrf', () => ({ apiFetch, getCsrfToken: () => 'token' }));

function mountForm(props: Record<string, unknown> = {}): VueWrapper {
  return mount(ScheduleForm, {
    props: { targetType: 'container', targetId: 'plex', ...props },
  });
}

/**
 * Mount and let one tick pass.
 *
 * seed() runs in onMounted, so an edited schedule's saved mode reaches the
 * select only on the render after mount.
 */
async function mountEdit(editId: number): Promise<VueWrapper> {
  const wrapper = mountForm({ editId });
  await wrapper.vm.$nextTick();
  return wrapper;
}

/** The quiesce select, found by id suffix because the prefix is generated. */
function quiesce(wrapper: VueWrapper): string {
  return (wrapper.find('[id$="-quiesce"]').element as HTMLSelectElement).value;
}

/** Report a database from the first path field, the way the endpoint does. */
async function reportDatabase(wrapper: VueWrapper, present = true) {
  wrapper.findAllComponents(PathSuggestInput)[0].vm.$emit('sqlite', present);
  await wrapper.vm.$nextTick();
}

/** A saved backup schedule. Id 7 is what mountEdit() looks up. */
function savedBackup(quiesceMode?: QuiesceMode): Schedule {
  return makeSchedule({
    id: 7,
    name: 'Nightly backup',
    action: 'backup',
    backup_config: { paths: ['/config'], ...(quiesceMode ? { quiesce: quiesceMode } : {}) },
  });
}

describe('ScheduleForm quiesce mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('starts on leave running, so nothing is paused without a reason', () => {
    expect(quiesce(mountForm())).toBe('none');
  });

  it('moves to pause when a chosen folder holds a database', async () => {
    const wrapper = mountForm();
    await reportDatabase(wrapper);

    expect(quiesce(wrapper)).toBe('pause');
    expect(wrapper.text()).toContain('so this was set to Pause');
  });

  it('stays on leave running when no database is found', async () => {
    const wrapper = mountForm();
    await reportDatabase(wrapper, false);

    expect(quiesce(wrapper)).toBe('none');
    expect(wrapper.text()).not.toContain('so this was set to Pause');
  });

  it('leaves a hand-picked mode alone and warns instead', async () => {
    const wrapper = mountForm();
    const select = wrapper.find('[id$="-quiesce"]');

    // Choosing 'none' with a database present is a decision, not an oversight.
    await select.setValue('none');
    await select.trigger('change');
    await reportDatabase(wrapper);

    expect(quiesce(wrapper)).toBe('none');
    expect(wrapper.text()).toContain('can produce a backup that does not restore');
  });

  it('does not overrule a mode the user already chose', async () => {
    const wrapper = mountForm();
    const select = wrapper.find('[id$="-quiesce"]');

    await select.setValue('stop');
    await select.trigger('change');
    await reportDatabase(wrapper);

    expect(quiesce(wrapper)).toBe('stop');
  });

  it('never moves a saved schedule, including one saved as leave running', async () => {
    const store = useScheduleStore();
    store.schedules = [savedBackup('none')];

    const wrapper = await mountEdit(7);
    expect(quiesce(wrapper)).toBe('none');

    await reportDatabase(wrapper);
    expect(quiesce(wrapper)).toBe('none');
  });

  it('reads a saved mode back out of the schedule', async () => {
    const store = useScheduleStore();
    store.schedules = [savedBackup('stop')];

    expect(quiesce(await mountEdit(7))).toBe('stop');
  });

  it('treats a schedule saved before the field existed as leave running', async () => {
    const store = useScheduleStore();
    store.schedules = [savedBackup()];

    expect(quiesce(await mountEdit(7))).toBe('none');
  });

  it('sends the chosen mode with the schedule', async () => {
    const store = useScheduleStore();
    const create = vi.spyOn(store, 'createSchedule').mockResolvedValue({ success: true, id: 1 });

    const wrapper = mountForm();
    await reportDatabase(wrapper);
    wrapper.findAllComponents(PathSuggestInput)[0].vm.$emit('update:modelValue', '/config');
    await wrapper.vm.$nextTick();

    await wrapper.findAll('button').filter((b) => b.text() === 'Create')[0].trigger('click');
    await wrapper.vm.$nextTick();

    const sent = create.mock.calls[0][0] as { backup_config: { quiesce: string } };
    expect(sent.backup_config.quiesce).toBe('pause');
  });
});
