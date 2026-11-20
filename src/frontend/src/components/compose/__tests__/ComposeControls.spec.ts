import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ComposeControls from '../ComposeControls.vue';
import { useComposeStore, type StackActionStatus } from '@/stores/compose';

function failureText(kind: StackActionStatus['kind']): string {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useComposeStore();
  store.stackActionStatus.set('web', { kind, error: 'Something broke' });
  const wrapper = mount(ComposeControls, { props: { projectName: 'web' }, global: { plugins: [pinia] } });
  return wrapper.find('span.text-error').text();
}

describe('ComposeControls failure line', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('names Remove Stack when a remove failed, not Stop All', () => {
    expect(failureText('remove')).toBe('Remove Stack failed: Something broke');
  });

  it('names Stop All for a failed stop', () => {
    expect(failureText('stop')).toBe('Stop All failed: Something broke');
  });

  it('names Stack Down for a failed down', () => {
    expect(failureText('down')).toBe('Stack Down failed: Something broke');
  });
});
