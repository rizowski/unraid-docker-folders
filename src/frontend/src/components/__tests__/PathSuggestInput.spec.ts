import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import PathSuggestInput from '../PathSuggestInput.vue';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/csrf', () => ({ apiFetch }));

function respondWith(entries: { name: string; path: string }[], hasSqlite = false) {
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ base: '/config', entries, has_sqlite: hasSqlite }),
  });
}

/** A request that never settles, so the seed stays on screen. */
function pendRequest() {
  apiFetch.mockReturnValue(new Promise(() => {}));
}

function mountInput(props: Record<string, unknown> = {}) {
  return mount(PathSuggestInput, {
    props: { modelValue: '', scope: 'container', container: 'plex', ...props },
  });
}

/** The payload of the last emit of $name. `.at()` is outside the tsconfig lib. */
function lastEmit(wrapper: VueWrapper, name: string): unknown[] | undefined {
  const events = wrapper.emitted(name);
  return events ? events[events.length - 1] : undefined;
}

function optionText(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[role="option"]').map((o) => o.text());
}

/** Let the keystroke timer fire and the mocked promise settle. */
async function settle(wrapper: VueWrapper) {
  await vi.advanceTimersByTimeAsync(250);
  await wrapper.vm.$nextTick();
}

describe('PathSuggestInput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetch.mockReset();
    respondWith([
      { name: 'databases', path: '/config/databases' },
      { name: 'logs', path: '/config/logs' },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the seed list before any response arrives', async () => {
    pendRequest();

    const wrapper = mountInput({ seed: ['/config', '/data'] });
    await wrapper.find('input').trigger('focus');
    await wrapper.vm.$nextTick();

    expect(optionText(wrapper)).toEqual(['/config', '/data']);
  });

  it('filters the seed list by what was typed', async () => {
    pendRequest();

    const wrapper = mountInput({ modelValue: '/da', seed: ['/config', '/data'] });
    await wrapper.find('input').trigger('focus');
    await wrapper.vm.$nextTick();

    expect(optionText(wrapper)).toEqual(['/data']);
  });

  it('waits for a pause in typing before asking the server', async () => {
    const wrapper = mountInput();
    const input = wrapper.find('input');

    await input.setValue('/con');
    await input.setValue('/conf');
    await input.setValue('/confi');

    // Three keystrokes inside the delay must not be three requests.
    expect(apiFetch).not.toHaveBeenCalled();

    await settle(wrapper);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('replaces the seed with the listing once it arrives', async () => {
    const wrapper = mountInput({ seed: ['/config'] });
    await wrapper.find('input').trigger('focus');
    await settle(wrapper);

    expect(optionText(wrapper)).toEqual(['databases', 'logs']);
  });

  it('sends the container name so the server can translate the path', async () => {
    const wrapper = mountInput({ modelValue: '/config/', container: 'sonarr' });
    await wrapper.find('input').trigger('focus');
    await settle(wrapper);

    const url = apiFetch.mock.calls[0][0] as string;
    expect(url).toContain('scope=container');
    expect(url).toContain('container=sonarr');
    expect(url).toContain('path=%2Fconfig%2F');
    expect(url).not.toContain('project=');
  });

  it('sends the compose project, because a service is not a container name', async () => {
    const wrapper = mountInput({ container: 'db', project: 'nextcloud' });
    await wrapper.find('input').trigger('focus');
    await settle(wrapper);

    const url = apiFetch.mock.calls[0][0] as string;
    expect(url).toContain('container=db');
    expect(url).toContain('project=nextcloud');
  });

  it('moves the highlight with the arrow keys and accepts with Enter', async () => {
    const wrapper = mountInput();
    const input = wrapper.find('input');

    await input.trigger('focus');
    await settle(wrapper);

    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });

    // A trailing slash, because accepting a folder means "show me inside it".
    expect(lastEmit(wrapper, 'update:modelValue')).toEqual(['/config/logs/']);
  });

  it('asks for the contents of a folder it just accepted', async () => {
    const wrapper = mountInput();
    const input = wrapper.find('input');

    await input.trigger('focus');
    await settle(wrapper);
    apiFetch.mockClear();

    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    await wrapper.vm.$nextTick();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when the same field is refocused', async () => {
    const wrapper = mountInput();
    const input = wrapper.find('input');

    await input.trigger('focus');
    await settle(wrapper);
    apiFetch.mockClear();

    await input.trigger('blur');
    await input.trigger('focus');
    await settle(wrapper);

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('asks again when the row starts naming a different container', async () => {
    const wrapper = mountInput({ container: 'db' });
    const input = wrapper.find('input');

    await input.trigger('focus');
    await settle(wrapper);
    apiFetch.mockClear();

    // A stack row names its container by service, and the user types that
    // name, so the list it holds belongs to the container before this one.
    await wrapper.setProps({ container: 'redis' });
    await input.trigger('blur');
    await input.trigger('focus');
    await settle(wrapper);

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('closes the list on Escape without changing the value', async () => {
    const wrapper = mountInput();
    const input = wrapper.find('input');

    await input.trigger('focus');
    await settle(wrapper);
    expect(optionText(wrapper)).toHaveLength(2);

    await input.trigger('keydown', { key: 'Escape' });
    expect(wrapper.findAll('[role="option"]')).toHaveLength(0);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('reports a database in the listed folder', async () => {
    respondWith([{ name: 'databases', path: '/config/databases' }], true);

    const wrapper = mountInput();
    await wrapper.find('input').trigger('focus');
    await settle(wrapper);

    expect(lastEmit(wrapper, 'sqlite')).toEqual([true]);
  });

  it('falls back to the seed when the request fails', async () => {
    apiFetch.mockRejectedValue(new Error('network failure'));

    const wrapper = mountInput({ seed: ['/config', '/data'] });
    await wrapper.find('input').trigger('focus');
    await settle(wrapper);

    expect(optionText(wrapper)).toEqual(['/config', '/data']);
  });

  it('never asks the server for a container it has no name for', async () => {
    const wrapper = mountInput({ container: '' });
    await wrapper.find('input').trigger('focus');
    await settle(wrapper);

    expect(apiFetch).not.toHaveBeenCalled();
  });
});
