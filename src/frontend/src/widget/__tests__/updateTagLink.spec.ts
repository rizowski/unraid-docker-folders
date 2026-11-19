import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// Vitest stubs every CSS import to an empty string (`?raw` and `?inline`
// included), and the project carries no @types/node, so read the file through
// a locally typed `node:fs`.
type FsModule = { readFileSync(path: string, enc: 'utf8'): string };
const nodeFs = 'node:fs';
import WidgetApp from '../WidgetApp.vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore } from '@/stores/stats';
import { useUpdatesStore } from '@/stores/updates';
import { useScheduleStore } from '@/stores/schedules';
import { makeContainer, makeFolder, makeUpdateStatus, makeReleaseStatus } from '@/test/fixtures';

vi.mock('@/composables/useLiveUpdates', () => ({ initLiveUpdates: vi.fn() }));

/**
 * The Update tag is an <a> when the image has release notes and a <span> when
 * it has none. It rendered in two colours because the reset
 * `#unraid-docker-folders-modern a { color: inherit }` was unlayered and beat
 * the `text-warning` utility (`@layer utilities`) on the link only.
 *
 * jsdom does not resolve the cascade through @layer, so these tests cannot
 * prove the rendered colour. They check the two things that decide it: the
 * link and the span carry the same colour classes, and the reset that would
 * override them sits in a cascade layer.
 */
describe('Update tag as a link', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('docker-folders-widget-settings', JSON.stringify({ startCollapsed: false }));
    document.body.innerHTML = '';
  });

  async function mountTags() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const docker = useDockerStore();
    docker.fetchContainers = vi.fn(async () => {});
    docker.containers = [
      makeContainer({ id: 'c1', name: 'plex', image: 'linuxserver/plex' }),
      makeContainer({ id: 'c2', name: 'pihole', image: 'pihole/pihole' }),
    ];
    const folders = useFolderStore();
    folders.fetchFolders = vi.fn(async () => {});
    folders.folders = [makeFolder(['plex', 'pihole'])];
    const settings = useSettingsStore();
    settings.fetchSettings = vi.fn(async () => {
      settings.loaded = true;
    });
    settings.enableUpdateChecks = true;
    const stats = useStatsStore();
    stats.registerVisible = vi.fn();
    stats.unregisterVisible = vi.fn();
    const updates = useUpdatesStore();
    updates.fetchCachedUpdates = vi.fn(async () => {});
    updates.updates = {
      'linuxserver/plex': makeReleaseStatus('linuxserver/plex', 'linuxserver/docker-plex', 'v1'),
      'pihole/pihole': makeUpdateStatus('pihole/pihole', true),
    };
    const schedules = useScheduleStore();
    schedules.fetchSchedules = vi.fn(async () => {});
    const wrapper = mount(WidgetApp, { global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();
    return wrapper;
  }

  it('renders the link tag and the span tag with the same colour classes', async () => {
    const wrapper = await mountTags();
    const tags = wrapper.findAll('.widget-row a, .widget-row span').filter((e) => e.text() === 'Update' && e.classes('bg-warning/20'));
    expect(tags.map((t) => t.element.tagName)).toEqual(['A', 'SPAN']);
    const colour = (el: Element) => [...el.classList].filter((c) => /^(bg|text)-warning/.test(c)).sort();
    expect(colour(tags[0].element)).toEqual(['bg-warning/20', 'text-warning']);
    expect(colour(tags[1].element)).toEqual(colour(tags[0].element));
  });

  it('keeps the link-colour reset inside a cascade layer', async () => {
    const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as FsModule;
    const css = readFileSync('src/assets/styles/main.css', 'utf8');
    // Remove every `@layer ... { ... }` block (brace matched), leaving what is unlayered.
    let unlayered = '';
    for (let i = 0; i < css.length; ) {
      const at = css.indexOf('@layer', i);
      if (at === -1) {
        unlayered += css.slice(i);
        break;
      }
      unlayered += css.slice(i, at);
      let depth = 0;
      let j = css.indexOf('{', at);
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) break;
      }
      i = j + 1;
    }
    const linkColourRule = /#unraid-docker-folders-modern\s+a\s*\{[^}]*\bcolor\s*:/;
    expect(css).toMatch(/@layer base\s*\{\s*#unraid-docker-folders-modern a\s*\{\s*color:\s*inherit;/);
    expect(unlayered).not.toMatch(linkColourRule);
  });
});
