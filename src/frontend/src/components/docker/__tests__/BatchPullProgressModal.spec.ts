import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import BatchPullProgressModal from '../BatchPullProgressModal.vue';
import { useSettingsStore } from '@/stores/settings';
import { makeContainer } from '@/test/fixtures';
import type { UpdateUnit } from '@/utils/updateUnits';

/**
 * A pull that stays open until the test releases it, so several units can be
 * observed in flight at the same moment.
 */
interface PendingPull {
  url: string;
  body: string;
  /** Emit `complete` + `done` and close the stream. */
  finish: (event?: 'complete' | 'error') => void;
  aborted: () => boolean;
}

let pending: PendingPull[] = [];
let inFlight = 0;
let maxInFlight = 0;
let pinia: ReturnType<typeof createPinia>;

function installFetchMock() {
  const encoder = new TextEncoder();

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);

      const signal = init.signal as AbortSignal;
      let release: ((event: 'complete' | 'error') => void) | null = null;
      const queue: Uint8Array[] = [];
      let waiter: ((v: any) => void) | null = null;
      let closed = false;

      function push(chunk: string) {
        const bytes = encoder.encode(chunk);
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve({ done: false, value: bytes });
        } else {
          queue.push(bytes);
        }
      }

      const entry: PendingPull = {
        url,
        body: String(init.body ?? ''),
        finish(event = 'complete') {
          release?.(event);
        },
        aborted: () => signal?.aborted ?? false,
      };
      pending.push(entry);

      release = (event) => {
        push(`event: ${event}\ndata: {"message":"done"}\n\n`);
        push('event: done\ndata: {"finished":true}\n\n');
        closed = true;
        inFlight--;
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve({ done: true, value: undefined });
        }
      };

      return Promise.resolve({
        ok: true,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve) => {
                if (queue.length > 0) {
                  resolve({ done: false, value: queue.shift() });
                } else if (closed) {
                  resolve({ done: true, value: undefined });
                } else {
                  waiter = resolve;
                }
              }),
          }),
        },
      });
    }),
  );
}

function imageUnit(image: string, names: string[]): UpdateUnit {
  return {
    kind: 'image',
    id: `image:${image}`,
    image,
    containers: names.map((name) => makeContainer({ id: `id-${name}`, name, image })),
  };
}

function composeUnit(project: string): UpdateUnit {
  return {
    kind: 'compose',
    id: `compose:${project}`,
    project,
    containers: [makeContainer({ id: `id-${project}`, name: project })],
  };
}

/**
 * Mount closed, then open — mirroring App.vue, which flips `isOpen` when the
 * unit list becomes non-empty. The batch starts on that transition.
 */
async function mountModal(units: UpdateUnit[]) {
  const wrapper = mount(BatchPullProgressModal, {
    props: { isOpen: false, units },
    global: {
      // The suite's own pinia, so settings set in a test are the ones the
      // component reads. A fresh createPinia() here would silently detach them.
      plugins: [pinia],
      stubs: { Teleport: true },
    },
  });
  await wrapper.setProps({ isOpen: true });
  return wrapper;
}

/** Let the pool spin until it stops opening new requests. */
async function settle() {
  for (let i = 0; i < 10; i++) await flushPromises();
}

describe('BatchPullProgressModal', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    pending = [];
    inFlight = 0;
    maxInFlight = 0;
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs at most `updateConcurrency` units at a time and completes all of them', async () => {
    const settings = useSettingsStore();
    settings.updateConcurrency = 3;

    const units = ['a', 'b', 'c', 'd', 'e'].map((n) => imageUnit(`img-${n}:latest`, [n]));
    const wrapper = await mountModal(units);
    await settle();

    // Pool is saturated at the limit, not running everything at once.
    expect(pending.length).toBe(3);
    expect(maxInFlight).toBe(3);

    // Releasing one frees exactly one slot for the next unit.
    pending[0].finish();
    await settle();
    expect(pending.length).toBe(4);

    for (const p of pending) p.finish();
    await settle();
    for (const p of pending) p.finish();
    await settle();

    expect(pending.length).toBe(5);
    expect(maxInFlight).toBe(3);
    expect(wrapper.emitted('complete')).toBeTruthy();
  });

  it('runs strictly one at a time when concurrency is 1', async () => {
    const settings = useSettingsStore();
    settings.updateConcurrency = 1;

    const units = ['a', 'b', 'c'].map((n) => imageUnit(`img-${n}:latest`, [n]));
    await mountModal(units);
    await settle();

    expect(pending.length).toBe(1);
    expect(maxInFlight).toBe(1);

    pending[0].finish();
    await settle();
    expect(pending.length).toBe(2);
    expect(maxInFlight).toBe(1);
  });

  it('sends the exact container set to pull.php so extras are not recreated', async () => {
    const settings = useSettingsStore();
    settings.updateConcurrency = 1;

    await mountModal([imageUnit('nginx:latest', ['web', 'web-2'])]);
    await settle();

    expect(pending[0].url).toContain('pull.php?image=nginx%3Alatest');
    const body = new URLSearchParams(pending[0].body);
    expect(body.get('containers')).toBe('id-web,id-web-2');
  });

  it('routes compose units to the compose CLI endpoint', async () => {
    const settings = useSettingsStore();
    settings.updateConcurrency = 1;
    settings.postPullAction = 'pull_and_auto_recreate';

    await mountModal([composeUnit('blog')]);
    await settle();

    expect(pending[0].url).toContain('compose-stream.php');
    expect(pending[0].url).toContain('action=up');
    expect(pending[0].url).toContain('project=blog');
  });

  it('uses compose pull (not up) when auto-recreate is off', async () => {
    const settings = useSettingsStore();
    settings.updateConcurrency = 1;
    settings.postPullAction = 'pull_only';

    await mountModal([composeUnit('blog')]);
    await settle();

    expect(pending[0].url).toContain('action=pull');
  });

  it('aborts every in-flight unit on cancel', async () => {
    const settings = useSettingsStore();
    settings.updateConcurrency = 3;

    const units = ['a', 'b', 'c'].map((n) => imageUnit(`img-${n}:latest`, [n]));
    const wrapper = await mountModal(units);
    await settle();

    expect(pending.length).toBe(3);
    expect(pending.every((p) => !p.aborted())).toBe(true);

    await wrapper.find('button').trigger('click'); // Cancel
    expect(pending.every((p) => p.aborted())).toBe(true);
  });

  it('does not emit complete when the modal closed mid-batch', async () => {
    const settings = useSettingsStore();
    settings.updateConcurrency = 2;

    const units = ['a', 'b'].map((n) => imageUnit(`img-${n}:latest`, [n]));
    const wrapper = await mountModal(units);
    await settle();

    await wrapper.setProps({ isOpen: false });
    for (const p of pending) p.finish();
    await settle();

    expect(wrapper.emitted('complete')).toBeFalsy();
  });
});
