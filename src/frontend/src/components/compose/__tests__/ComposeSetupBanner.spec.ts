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
    expect(note.text()).toBe(
      'Installing also keeps a copy on the flash drive (about 65 MB) and reinstalls Compose after a reboot. You can turn this off in Settings.'
    );
  });

  it('shows the flash copy warning after an install that worked without a copy', () => {
    const compose = useComposeStore();
    compose.statusChecked = true;
    compose.status = { ...compose.status, compose_available: true };
    compose.installWarning = 'Docker Compose is installed, but the copy on the flash drive failed, so it is downloaded again at boot.';

    const wrapper = mount(ComposeSetupBanner, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="compose-install-warning"]').text()).toContain('flash drive failed');
  });

  it('shows no warning when there is none', () => {
    const wrapper = mount(ComposeSetupBanner, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="compose-install-warning"]').exists()).toBe(false);
  });

  it('shows no install banner, and so no note, once Compose is installed', () => {
    const compose = useComposeStore();
    compose.statusChecked = true;
    compose.status = { ...compose.status, compose_available: true };

    const wrapper = mount(ComposeSetupBanner, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="compose-reboot-note"]').exists()).toBe(false);
  });
});
