import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import ComposeSetupBanner from '../ComposeSetupBanner.vue';
import { useComposeStore } from '@/stores/compose';

let pinia: Pinia;

describe('ComposeSetupBanner', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it('tells the user Compose comes back after a reboot and that Settings turns it off', () => {
    const compose = useComposeStore();
    compose.statusChecked = true;
    compose.status = { ...compose.status, compose_available: false };

    const wrapper = mount(ComposeSetupBanner, { global: { plugins: [pinia] } });
    const note = wrapper.find('[data-testid="compose-reboot-note"]');
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain('reinstalled after a reboot');
    expect(note.text()).toContain('Settings');
  });

  it('shows no install banner, and so no note, once Compose is installed', () => {
    const compose = useComposeStore();
    compose.statusChecked = true;
    compose.status = { ...compose.status, compose_available: true };

    const wrapper = mount(ComposeSetupBanner, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="compose-reboot-note"]').exists()).toBe(false);
  });
});
