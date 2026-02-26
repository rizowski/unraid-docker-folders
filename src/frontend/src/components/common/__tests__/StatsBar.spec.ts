import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatsBar from '../StatsBar.vue';

function mountBar(props: { label: string; percent: number | null; size?: 'compact' | 'inline' | 'wide'; formattedValue?: string }) {
  return mount(StatsBar, { props });
}

describe('StatsBar', () => {
  describe('loading skeleton (percent=null)', () => {
    it('renders loading placeholder text for compact size', () => {
      const wrapper = mountBar({ label: 'CPU', percent: null });
      expect(wrapper.text()).toContain('CPU');
      expect(wrapper.text()).toContain('--');
      expect(wrapper.find('.animate-pulse').exists()).toBe(true);
    });

    it('renders loading placeholder for inline size', () => {
      const wrapper = mountBar({ label: 'MEM', percent: null, size: 'inline' });
      expect(wrapper.text()).toContain('MEM');
      expect(wrapper.text()).toContain('--');
      expect(wrapper.find('.animate-pulse').exists()).toBe(true);
    });

    it('renders loading placeholder for wide size', () => {
      const wrapper = mountBar({ label: 'CPU', percent: null, size: 'wide' });
      expect(wrapper.text()).toContain('CPU');
      expect(wrapper.text()).toContain('--');
      expect(wrapper.find('.animate-pulse').exists()).toBe(true);
    });

    it('does not render a filled bar when loading', () => {
      const wrapper = mountBar({ label: 'CPU', percent: null });
      expect(wrapper.find('.bg-success').exists()).toBe(false);
      expect(wrapper.find('.bg-warning').exists()).toBe(false);
      expect(wrapper.find('.bg-error').exists()).toBe(false);
    });
  });

  describe('filled bar', () => {
    it('renders label and formatted percent', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 45.3 });
      expect(wrapper.text()).toContain('CPU');
      expect(wrapper.text()).toContain('45.3%');
    });

    it('uses custom formattedValue when provided', () => {
      const wrapper = mountBar({ label: 'Memory', percent: 60, size: 'wide', formattedValue: '1.2 GB / 2.0 GB' });
      expect(wrapper.text()).toContain('1.2 GB / 2.0 GB');
      // Should show the custom value, not the raw percent
      expect(wrapper.text()).not.toContain('60.0%');
    });

    it('does not show loading pulse when percent is provided', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 25 });
      expect(wrapper.find('.animate-pulse').exists()).toBe(false);
    });
  });

  describe('bar color thresholds', () => {
    it('uses green (bg-success) for percent <= 50', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 30 });
      expect(wrapper.find('.bg-success').exists()).toBe(true);
    });

    it('uses green at exactly 50%', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 50 });
      expect(wrapper.find('.bg-success').exists()).toBe(true);
    });

    it('uses yellow (bg-warning) for percent > 50 and <= 80', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 65 });
      expect(wrapper.find('.bg-warning').exists()).toBe(true);
    });

    it('uses yellow at exactly 80%', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 80 });
      expect(wrapper.find('.bg-warning').exists()).toBe(true);
    });

    it('uses red (bg-error) for percent > 80', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 95 });
      expect(wrapper.find('.bg-error').exists()).toBe(true);
    });

    it('uses red at 81%', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 81 });
      expect(wrapper.find('.bg-error').exists()).toBe(true);
    });
  });

  describe('bar width', () => {
    it('sets width style to percent value', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 42.5 });
      const bar = wrapper.find('[style]');
      expect(bar.attributes('style')).toContain('width: 42.5%');
    });

    it('caps width at 100% for values over 100', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 150 });
      const bar = wrapper.find('[style]');
      expect(bar.attributes('style')).toContain('width: 100%');
    });

    it('handles 0%', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 0 });
      const bar = wrapper.find('[style]');
      expect(bar.attributes('style')).toContain('width: 0%');
    });
  });

  describe('inline size uses fixed width track', () => {
    it('inline loading skeleton has w-16 on the track', () => {
      const wrapper = mountBar({ label: 'CPU', percent: null, size: 'inline' });
      const track = wrapper.find('.stats-bar-track');
      expect(track.classes()).toContain('w-16');
      expect(track.classes()).not.toContain('flex-1');
    });

    it('inline filled bar has w-16 on the track', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 50, size: 'inline' });
      const track = wrapper.find('.stats-bar-track');
      expect(track.classes()).toContain('w-16');
      expect(track.classes()).not.toContain('flex-1');
    });
  });

  describe('size variants render correctly', () => {
    it('compact (default) renders bar track with flex-1', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 50 });
      const track = wrapper.find('.stats-bar-track');
      expect(track.classes()).toContain('flex-1');
    });

    it('wide renders bar track with w-full', () => {
      const wrapper = mountBar({ label: 'CPU', percent: 50, size: 'wide' });
      const track = wrapper.find('.stats-bar-track');
      expect(track.classes()).toContain('w-full');
    });
  });
});
