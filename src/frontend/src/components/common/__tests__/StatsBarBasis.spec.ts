import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatsBar from '../StatsBar.vue';

describe('StatsBar basis label', () => {
  it('shows the suffix after the value on the compact size, and the title on the row', () => {
    const wrapper = mount(StatsBar, {
      props: { label: 'MEM', percent: 23.3, suffix: 'of limit', title: '952.4 MB of the 4.0 GB container limit.' },
    });
    expect(wrapper.text()).toContain('23.3%');
    expect(wrapper.text()).toContain('of limit');
    expect(wrapper.find('[title]').attributes('title')).toBe('952.4 MB of the 4.0 GB container limit.');
  });

  it('reserves the suffix room with an empty string, and shows none without the prop', () => {
    const reserved = mount(StatsBar, { props: { label: 'CPU', percent: 10, suffix: '' } });
    expect(reserved.findAll('span').length).toBe(3);
    const plain = mount(StatsBar, { props: { label: 'CPU', percent: 10 } });
    expect(plain.findAll('span').length).toBe(2);
  });

  it('colors the bar by levelPercent when given, and sizes it by percent', () => {
    const wrapper = mount(StatsBar, { props: { label: 'MEM', percent: 3, levelPercent: 95 } });
    const fill = wrapper.find('.bg-error');
    expect(fill.exists()).toBe(true);
    expect(fill.attributes('style')).toContain('width: 3%');
  });

  it('colors by the shown percent when there is no levelPercent', () => {
    const wrapper = mount(StatsBar, { props: { label: 'MEM', percent: 3 } });
    expect(wrapper.find('.bg-success').exists()).toBe(true);
  });
});
