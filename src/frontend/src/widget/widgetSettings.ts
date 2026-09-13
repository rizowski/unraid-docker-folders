/**
 * The widget's own display choices. They live in localStorage, per browser,
 * because they only change how the dashboard tile looks.
 */

import { safeLocalStorageGet, safeLocalStorageSet } from '@/utils/safeStorage';

export interface WidgetSettings {
  /** Show only running and paused containers. */
  hideStopped: boolean;
  /** Folders the user never opened or closed start closed. */
  startCollapsed: boolean;
  /** Globe link on running containers that have a WebUI. */
  showWebui: boolean;
  /** Container images. Off shows a small status dot instead. */
  showIcons: boolean;
}

export const WIDGET_SETTINGS_KEY = 'docker-folders-widget-settings';

export const DEFAULT_WIDGET_SETTINGS: Readonly<WidgetSettings> = {
  hideStopped: false,
  startCollapsed: true,
  showWebui: true,
  showIcons: true,
};

/** Saved settings over the defaults. A missing or malformed value keeps its default. */
export function loadWidgetSettings(): WidgetSettings {
  const settings = { ...DEFAULT_WIDGET_SETTINGS };
  try {
    const saved = JSON.parse(safeLocalStorageGet(WIDGET_SETTINGS_KEY) || '{}');
    for (const key of Object.keys(settings) as Array<keyof WidgetSettings>) {
      if (typeof saved?.[key] === 'boolean') settings[key] = saved[key];
    }
  } catch {
    // Unparseable JSON: keep the defaults.
  }
  return settings;
}

export function saveWidgetSettings(settings: WidgetSettings): void {
  safeLocalStorageSet(WIDGET_SETTINGS_KEY, JSON.stringify(settings));
}
