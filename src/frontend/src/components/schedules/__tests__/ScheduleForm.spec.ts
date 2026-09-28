import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ScheduleForm from '../ScheduleForm.vue';
import PathSuggestInput from '@/components/PathSuggestInput.vue';
import { useScheduleStore } from '@/stores/schedules';
import type { Schedule, QuiesceMode } from '@/types/schedule';
import { makeContainer, makeSchedule } from '@/test/fixtures';
import { useDockerStore } from '@/stores/docker';

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

/** The cron preset select, found by id suffix because the prefix is generated. */
function cronPreset(wrapper: VueWrapper): string {
  return (wrapper.find('[id$="-cron-preset"]').element as HTMLSelectElement).value;
}

async function chooseAction(wrapper: VueWrapper, action: string) {
  const select = wrapper.find('[id$="-action"]');
  await select.setValue(action);
  await select.trigger('change');
}

describe('ScheduleForm update action', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('offers Update for a container target', () => {
    const wrapper = mountForm({ targetType: 'container' });
    expect(wrapper.find('option[value="update"]').exists()).toBe(true);
  });

  it('does not offer Update for a stack target', () => {
    const wrapper = mountForm({ targetType: 'stack', targetId: 'my-stack' });
    expect(wrapper.find('option[value="update"]').exists()).toBe(false);
  });

  it('shows the help line only once Update is chosen', async () => {
    const wrapper = mountForm();
    expect(wrapper.text()).not.toContain('Checks for a newer image');

    await chooseAction(wrapper, 'update');
    expect(wrapper.text()).toContain('Checks for a newer image');
    expect(wrapper.text()).toContain('A run more than');
    expect(wrapper.text()).toContain('5 minutes late is skipped');
  });

  it('defaults a new schedule to the hourly preset when switched to Update', async () => {
    const wrapper = mountForm();

    // Untouched, the form still carries its daily-at-3am default.
    expect(cronPreset(wrapper)).toBe('daily_3am');

    await chooseAction(wrapper, 'update');
    expect(cronPreset(wrapper)).toBe('every_hour');
  });

  it('puts the earlier time back when the user leaves Update', async () => {
    const wrapper = mountForm();

    await chooseAction(wrapper, 'update');
    expect(cronPreset(wrapper)).toBe('every_hour');

    await chooseAction(wrapper, 'backup');
    expect(cronPreset(wrapper)).toBe('daily_3am');
  });

  it('leaves a cron the user already picked alone when switching to Update', async () => {
    const wrapper = mountForm();
    const preset = wrapper.find('[id$="-cron-preset"]');
    await preset.setValue('weekly_custom');
    await preset.trigger('change');

    await chooseAction(wrapper, 'update');
    expect(cronPreset(wrapper)).toBe('weekly_custom');
  });

  it('does not touch cron for a saved schedule already using Update', async () => {
    const store = useScheduleStore();
    store.schedules = [makeSchedule({
      id: 9, action: 'update', target_type: 'container', target_id: 'plex', cron_expression: '0 5 * * *',
    })];

    const wrapper = await mountEdit(9);
    expect(cronPreset(wrapper)).toBe('daily_custom');
  });
});

/** Answer the two Postgres calls; everything else gets an empty body. */
function routePostgres(info: Record<string, unknown>, databases: string[] = ['app', 'postgres']) {
  apiFetch.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes('action=postgres_info')) return info;
      if (url.includes('action=postgres_databases')) return { success: true, databases, message: '' };
      return {};
    },
  }));
}

/** The JSON body the form posted to an action. apiFetch is mocked, so it is still JSON. */
function sentTo(action: string): Record<string, unknown> {
  const call = apiFetch.mock.calls.find(([url]) => String(url).includes(`action=${action}`));
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}'));
}

const PG_INFO = { is_postgres: true, running: true, env_user: 'app', has_env_password: true };

function pgMode(wrapper: VueWrapper): boolean {
  return (wrapper.find('[id$="-pg-mode"]').element as HTMLInputElement).checked;
}

function button(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').filter((b) => b.text() === text)[0];
}

async function loadAndCreate(wrapper: VueWrapper) {
  await button(wrapper, 'Load databases').trigger('click');
  await flushPromises();
  await button(wrapper, 'Create').trigger('click');
  await flushPromises();
}

describe('ScheduleForm Postgres mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    apiFetch.mockReset();
  });

  it('turns on for a container the server says runs Postgres, and hides paths and quiesce', async () => {
    routePostgres(PG_INFO);
    const wrapper = mountForm({ targetId: 'db' });
    await flushPromises();

    expect(pgMode(wrapper)).toBe(true);
    expect(wrapper.text()).toContain('Postgres detected');
    expect(wrapper.find('[id$="-quiesce"]').exists()).toBe(false);
    expect(wrapper.findAllComponents(PathSuggestInput)).toHaveLength(1); // destination only
    expect(wrapper.text()).toContain('POSTGRES_USER (app)');
  });

  it('stays off for other containers', async () => {
    routePostgres({ ...PG_INFO, is_postgres: false });
    const wrapper = mountForm();
    await flushPromises();

    expect(pgMode(wrapper)).toBe(false);
    expect(wrapper.find('[id$="-quiesce"]').exists()).toBe(true);
  });

  it('uses the container env by default and saves no credentials', async () => {
    routePostgres(PG_INFO);
    const store = useScheduleStore();
    const create = vi.spyOn(store, 'createSchedule').mockResolvedValue({ success: true, id: 1 });
    const wrapper = mountForm({ targetId: 'db' });
    await flushPromises();

    expect(wrapper.find('[id$="-pg-user"]').exists()).toBe(false);
    expect(button(wrapper, 'Create').attributes('disabled')).toBeDefined();

    await button(wrapper, 'Load databases').trigger('click');
    await flushPromises();
    expect(sentTo('postgres_databases')).toEqual({ target_type: 'container', target_id: 'db', credentials: 'env' });
    expect(wrapper.text()).toContain('Found 2 databases');

    // Untick "postgres", keep "app".
    await wrapper.find('[id$="-pg-db-postgres"]').setValue(false);
    await button(wrapper, 'Create').trigger('click');
    await flushPromises();

    const sent = create.mock.calls[0][0] as unknown as { backup_config: Record<string, unknown> };
    expect(sent.backup_config).toEqual({
      mode: 'postgres',
      paths: [],
      postgres: { credentials: 'env', databases: ['app'] },
    });
  });

  it('sends a custom user and password when chosen', async () => {
    routePostgres(PG_INFO, ['app']);
    const store = useScheduleStore();
    const create = vi.spyOn(store, 'createSchedule').mockResolvedValue({ success: true, id: 1 });
    const wrapper = mountForm({ targetId: 'db' });
    await flushPromises();

    await wrapper.find('[id$="-pg-credentials"]').setValue('custom');
    await wrapper.find('[id$="-pg-user"]').setValue('backup');
    await wrapper.find('[id$="-pg-password"]').setValue('pw');
    await loadAndCreate(wrapper);

    expect(sentTo('postgres_databases')).toMatchObject({ credentials: 'custom', user: 'backup', password: 'pw' });
    const sent = create.mock.calls[0][0] as unknown as { backup_config: { postgres: Record<string, unknown> } };
    expect(sent.backup_config.postgres).toEqual({
      credentials: 'custom',
      user: 'backup',
      password: 'pw',
      databases: ['app'],
    });
  });

  it('keeps the saved password on edit by sending it empty', async () => {
    routePostgres(PG_INFO);
    const store = useScheduleStore();
    store.schedules = [
      makeSchedule({
        id: 7,
        target_id: 'db',
        action: 'backup',
        backup_config: {
          mode: 'postgres',
          paths: [],
          postgres: { credentials: 'custom', user: 'backup', password_set: true, databases: ['app'] },
        },
      }),
    ];
    const update = vi.spyOn(store, 'updateSchedule').mockResolvedValue(true);
    const wrapper = mountForm({ targetId: 'db', editId: 7 });
    await flushPromises();

    expect(wrapper.find('[id$="-pg-password"]').attributes('placeholder')).toContain('Saved');
    await button(wrapper, 'Update').trigger('click');
    await flushPromises();

    const sent = update.mock.calls[0][1] as unknown as { backup_config: { postgres: Record<string, unknown> } };
    expect(sent.backup_config.postgres).toEqual({
      credentials: 'custom',
      user: 'backup',
      password: '',
      databases: ['app'],
    });
  });

  it('picks the Postgres service of a stack and sends it', async () => {
    routePostgres(PG_INFO, ['immich']);
    const docker = useDockerStore();
    docker.containers = [
      makeContainer({
        name: 'immich-server-1',
        image: 'ghcr.io/immich-app/immich-server:release',
        labels: { 'com.docker.compose.project': 'immich', 'com.docker.compose.service': 'server' },
      }),
      makeContainer({
        name: 'immich-database-1',
        image: 'ghcr.io/immich-app/postgres:14-vectorchord0.3.0',
        labels: { 'com.docker.compose.project': 'immich', 'com.docker.compose.service': 'database' },
      }),
    ];
    const store = useScheduleStore();
    const create = vi.spyOn(store, 'createSchedule').mockResolvedValue({ success: true, id: 1 });
    const wrapper = mountForm({ targetType: 'stack', targetId: 'immich' });
    await flushPromises();

    expect(pgMode(wrapper)).toBe(true);
    expect((wrapper.find('[id$="-pg-service"]').element as HTMLSelectElement).value).toBe('database');
    expect(sentTo('postgres_info')).toEqual({ target_type: 'stack', target_id: 'immich', service: 'database' });

    await loadAndCreate(wrapper);
    const sent = create.mock.calls[0][0] as unknown as { backup_config: { postgres: Record<string, unknown> } };
    expect(sent.backup_config.postgres).toEqual({ service: 'database', credentials: 'env', databases: ['immich'] });
  });
});
