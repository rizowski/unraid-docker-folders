/**
 * The widget's own display choices. They live in localStorage, per browser,
 * because they only change how the dashboard tile looks.
 */

import { safeLocalStorageGetJson, safeLocalStorageSet } from '@/utils/safeStorage';

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
  const saved = safeLocalStorageGetJson(WIDGET_SETTINGS_KEY) as Partial<Record<keyof WidgetSettings, unknown>> | null;
  for (const key of Object.keys(settings) as Array<keyof WidgetSettings>) {
    const value = saved?.[key];
    if (typeof value === 'boolean') settings[key] = value;
  }
  return settings;
}

export function saveWidgetSettings(settings: WidgetSettings): void {
  safeLocalStorageSet(WIDGET_SETTINGS_KEY, JSON.stringify(settings));
}
