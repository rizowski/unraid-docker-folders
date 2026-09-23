/**
 * The stream/poll switching behind `ComposeFileEditor.vue`'s Logs tab.
 *
 * Pulled out of the component so it can be unit-tested without mounting a
 * Vue SFC (the component has no existing test harness — see
 * `src/components/compose/__tests__` for the sibling components that do).
 *
 * In GraphQL mode (`getLive()` returns the `live` backend), `start()` opens
 * `live.composeLogs`: the first chunk replaces the accumulated text, every
 * later chunk is appended, and the result is clamped to the last `maxLines`
 * lines — matching the polling path's `tail: 500`. If the stream ends
 * unexpectedly while the controller is still active (the pane wasn't closed
 * and auto-refresh wasn't turned off), it falls back to the existing 3s
 * poll (`pollTick`) and retries the stream after `retryMs`.
 *
 * In PHP mode (no `live`), `start()` just runs `pollTick()` immediately and
 * on the existing interval — byte-for-byte the polling this replaces.
 */

import type { Backend, LiveHandlers } from '@/backends/types';

const DEFAULT_TAIL = 500;
const DEFAULT_MAX_LINES = 500;
const DEFAULT_RETRY_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

export interface ComposeLogsStreamDeps {
  /** Returns the active backend's `live` support, or undefined in PHP mode. Read fresh on every `start()`. */
  getLive: () => Backend['live'] | undefined;
  /** The project to stream. Read fresh when the stream opens. */
  getProjectName: () => string;
  /** Runs one poll tick (fetch tail + apply). The same function the 3s timer already called. */
  pollTick: () => void | Promise<void>;
  tail?: number;
  maxLines?: number;
  retryMs?: number;
  pollIntervalMs?: number;
}

export interface ComposeLogsStreamHandlers {
  /** Called with the full accumulated (already-clamped) log text after each stream chunk. Not called by the poll path — `pollTick` owns that. */
  onContent: (content: string) => void;
}

/**
 * Appends `chunk` to `existing` and keeps only the last `maxLines` lines —
 * the streaming equivalent of `getLogs(project, 500)` always asking for the
 * last 500. Exported standalone because the line-clamping is the one piece
 * of this module worth testing in total isolation from timers.
 */
export function appendComposeLogChunk(existing: string, chunk: string, maxLines = DEFAULT_MAX_LINES): string {
  const combined = existing === '' ? chunk : `${existing}\n${chunk}`;
  const lines = combined.split('\n');
  return lines.length > maxLines ? lines.slice(lines.length - maxLines).join('\n') : combined;
}

export function useComposeLogsStream(deps: ComposeLogsStreamDeps, handlers: ComposeLogsStreamHandlers) {
  const tail = deps.tail ?? DEFAULT_TAIL;
  const maxLines = deps.maxLines ?? DEFAULT_MAX_LINES;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let active = false;
  let closeStream: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function startTimedPolling(): void {
    if (pollTimer != null) return;
    void deps.pollTick();
    pollTimer = setInterval(() => void deps.pollTick(), pollIntervalMs);
  }

  function stopTimedPolling(): void {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function openStream(): boolean {
    const live = deps.getLive();
    if (!live) return false;

    let first = true;
    let content = '';
    const streamHandlers: LiveHandlers<{ output: string }> = {
      onData: (data) => {
        if (!data.output) return;
        content = first ? data.output : appendComposeLogChunk(content, data.output, maxLines);
        first = false;
        handlers.onContent(content);
      },
      onEnd: (error) => {
        closeStream = null;
        if (!active) return;
        if (error) console.warn('Compose log stream ended, polling instead:', error);
        startTimedPolling();
        retryTimer = setTimeout(() => {
          if (active) start();
        }, retryMs);
      },
    };

    closeStream = live.composeLogs(deps.getProjectName(), tail, streamHandlers);
    return true;
  }

  function start(): void {
    stopInternal();
    active = true;
    if (openStream()) return;
    startTimedPolling();
  }

  function stopInternal(): void {
    stopTimedPolling();
    closeStream?.();
    closeStream = null;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function stop(): void {
    active = false;
    stopInternal();
  }

  return { start, stop };
}
