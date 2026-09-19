import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CronInput from '../CronInput.vue';

// Mount with v-model wired back into the prop, the way ScheduleForm uses it.
function mountWithModel(initial: string) {
  const wrapper: VueWrapper = mount(CronInput, {
    props: {
      modelValue: initial,
      'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }),
    },
  });
  return wrapper;
}

function presetValue(wrapper: ReturnType<typeof mountWithModel>) {
  return (wrapper.find('select').element as HTMLSelectElement).value;
}

describe('CronInput', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('detects a daily expression on mount', () => {
    const wrapper = mountWithModel('30 4 * * *');
    expect(presetValue(wrapper)).toBe('daily_custom');
    expect((wrapper.find('input[type="time"]').element as HTMLInputElement).value).toBe('04:30');
  });

  it('keeps the custom field while typing through an expression that matches a preset', async () => {
    const wrapper = mountWithModel('0 3 * * *');
    await wrapper.find('select').setValue('custom');

    const input = () => wrapper.find('input.mono');
    expect(input().exists()).toBe(true);

    // "45 6 * * 1" is a prefix of "45 6 * * 1-5" and matches weekly_custom.
    for (const step of ['4', '45 6 * *', '45 6 * * 1', '45 6 * * 1-', '45 6 * * 1-5']) {
      await input().setValue(step);
      expect(input().exists()).toBe(true);
      expect(presetValue(wrapper)).toBe('custom');
    }

    const emitted = wrapper.emitted('update:modelValue') ?? [];
    expect(emitted[emitted.length - 1]).toEqual(['45 6 * * 1-5']);
  });

  it('still detects the preset when the value changes from outside', async () => {
    const wrapper = mountWithModel('0 3 * * *');
    await wrapper.find('select').setValue('custom');
    await wrapper.find('input.mono').setValue('*/5 * * * *');

    await wrapper.setProps({ modelValue: '15 2 * * 3' });
    expect(presetValue(wrapper)).toBe('weekly_custom');
  });
});
