import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_WIDGET_SETTINGS, WIDGET_SETTINGS_KEY, loadWidgetSettings, saveWidgetSettings } from '../widgetSettings';

describe('widgetSettings', () => {
  beforeEach(() => window.localStorage.clear());

  it('returns the defaults when nothing is saved', () => {
    expect(loadWidgetSettings()).toEqual(DEFAULT_WIDGET_SETTINGS);
  });

  it('round-trips saved settings', () => {
    const settings = { hideStopped: true, startCollapsed: false, showWebui: false, showIcons: false };
    saveWidgetSettings(settings);
    expect(loadWidgetSettings()).toEqual(settings);
  });

  it('keeps the default for a missing or non-boolean value', () => {
    window.localStorage.setItem(WIDGET_SETTINGS_KEY, JSON.stringify({ hideStopped: 'yes', showIcons: false }));
    expect(loadWidgetSettings()).toEqual({ ...DEFAULT_WIDGET_SETTINGS, showIcons: false });
  });

  it('keeps the defaults for unparseable JSON', () => {
    window.localStorage.setItem(WIDGET_SETTINGS_KEY, '{nope');
    expect(loadWidgetSettings()).toEqual(DEFAULT_WIDGET_SETTINGS);
  });
});
