import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import LoadingSkeleton from '../LoadingSkeleton.vue';

describe('LoadingSkeleton', () => {
  it('announces the load to screen readers', () => {
    const wrapper = mount(LoadingSkeleton, { props: { view: 'grid' } });
    const status = wrapper.find('[role="status"]');
    expect(status.attributes('aria-busy')).toBe('true');
    expect(status.text()).toContain('Loading...');
  });

  it('shows cards in grid view and rows in list view', () => {
    const grid = mount(LoadingSkeleton, { props: { view: 'grid' } });
    const list = mount(LoadingSkeleton, { props: { view: 'list' } });
    expect(grid.findAll('.rounded-lg')).toHaveLength(3);
    expect(list.findAll('.rounded-lg')).toHaveLength(0);
    expect(list.findAll('.border.rounded')).toHaveLength(3);
  });
});
