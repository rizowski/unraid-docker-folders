import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WidgetStatGauges from '../WidgetStatGauges.vue';

describe('WidgetStatGauges memory level', () => {
  it('colors the memory text and bar by memoryLevel when given, and sizes the bar by the shown percent', () => {
    // 3% of the host, but 95% of the container's own limit.
    const wrapper = mount(WidgetStatGauges, { props: { cpu: 1, memory: 3, memoryLevel: 95 } });
    const [, mem] = wrapper.findAll('.widget-stat');
    expect(mem.text()).toContain('3.0%');
    expect(mem.find('.text-error').exists()).toBe(true);
    const fill = mem.find('.bg-error');
    expect(fill.exists()).toBe(true);
    expect(fill.attributes('style')).toContain('width: 3%');
  });

  it('follows the shown percent without memoryLevel', () => {
    const wrapper = mount(WidgetStatGauges, { props: { cpu: 1, memory: 3 } });
    const [, mem] = wrapper.findAll('.widget-stat');
    expect(mem.find('.bg-success').exists()).toBe(true);
    expect(mem.find('.text-error').exists()).toBe(false);
  });
});
