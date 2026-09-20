/**
 * Container display and hand-off helpers shared by the Folders page card and
 * the dashboard widget, so the two can never disagree about a container.
 */

import type { Container } from '@/stores/docker';

/**
 * The generic Docker whale, shown when a container's template names no icon.
 * BASE_URL differs between the dev server and the plugin path on Unraid, so the
 * URL has to be built rather than written as a literal.
 */
export const FALLBACK_CONTAINER_ICON = `${import.meta.env.BASE_URL}docker.svg`;

export interface ContainerStatus {
  /** Halo state class for ContainerIcon, e.g. `status-halo-success`. */
  halo: string;
  tooltip: string;
}

// Health/state is carried by a feathered halo around the container icon (see
// .status-halo in main.css). Halo and tooltip resolve together so a newly
// handled state can't land in one and be forgotten in the other — they were
// once two parallel branch chains.
export function containerStatus(container: Pick<Container, 'state' | 'status'>, distinguishHealthy: boolean): ContainerStatus {
  const state = container.state;
  if (state === 'running') {
    if (!distinguishHealthy) return { halo: 'status-halo-success', tooltip: 'Running' };
    return container.status?.toLowerCase().includes('(healthy)')
      ? { halo: 'status-halo-success', tooltip: 'Running (healthy)' }
      : { halo: 'status-halo-info', tooltip: 'Running (no health check)' };
  }
  if (state === 'paused') return { halo: 'status-halo-warning', tooltip: 'Paused' };
  if (state === 'exited') return { halo: 'status-halo-error', tooltip: 'Exited' };
  if (state === 'stopped') return { halo: 'status-halo-error', tooltip: 'Stopped' };
  if (state === 'created') return { halo: 'status-halo-muted', tooltip: 'Created' };
  return { halo: 'status-halo-muted', tooltip: state.charAt(0).toUpperCase() + state.slice(1) };
}

/**
 * The container's WebUI link, with Unraid's `[IP]` and `[PORT:n]` template
 * placeholders filled in, or null when the template has no WebUI.
 */
export function containerWebuiUrl(container: Pick<Container, 'webui' | 'ports'>): string | null {
  const tpl = container.webui;
  if (!tpl) return null;
  return tpl
    .replace('[IP]', window.location.hostname)
    .replace(/\[PORT:(\d+)\]/g, (_match, privatePort) => {
      const mapped = container.ports?.find((p) => p.PrivatePort === parseInt(privatePort));
      return mapped?.PublicPort ? String(mapped.PublicPort) : privatePort;
    });
}

/** Running or paused. "Hide stopped" keeps these, because both are alive. */
export function isAliveContainer(container?: Pick<Container, 'state'>): boolean {
  return container?.state === 'running' || container?.state === 'paused';
}

/** Unraid's edit form, or null when Unraid does not manage the container. */
export function containerEditUrl(container: Pick<Container, 'managed' | 'name'>): string | null {
  if (container.managed !== 'dockerman') return null;
  return `/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-${container.name}.xml`;
}

/**
 * Open Unraid's console or log terminal. `openTerminal` comes from dockerMan's
 * docker.js, which both the Docker page and the Dashboard load.
 */
export function openContainerTerminal(name: string, mode: 'console' | 'logs'): void {
  const more = mode === 'logs' ? '.log' : 'sh';
  const parentWindow = window.parent as typeof window & { openTerminal?: (tag: string, name: string, more: string) => void };
  if (parentWindow?.openTerminal) {
    parentWindow.openTerminal('docker', name, more);
  } else {
    // Fallback: open directly (dev mode or not in iframe)
    const suffix = mode === 'logs' ? `${encodeURIComponent(name)}.log` : encodeURIComponent(name);
    window.open(`/logterminal/${suffix}/`, '_blank');
  }
}
