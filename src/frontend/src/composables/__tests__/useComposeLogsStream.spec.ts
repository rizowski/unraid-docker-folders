import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendComposeLogChunk, useComposeLogsStream } from '../useComposeLogsStream';
import type { Backend, LiveHandlers } from '@/backends/types';

describe('appendComposeLogChunk', () => {
  it('replaces empty content with the chunk', () => {
    expect(appendComposeLogChunk('', 'first')).toBe('first');
  });

  it('appends with a newline between existing content and the chunk', () => {
    expect(appendComposeLogChunk('a\nb', 'c')).toBe('a\nb\nc');
  });

  it('keeps only the last maxLines lines once the combined text is longer', () => {
    const existing = ['1', '2', '3'].join('\n');
    expect(appendComposeLogChunk(existing, '4\n5', 4)).toBe('2\n3\n4\n5');
  });
});

/** A controllable stand-in for `Backend['live'].composeLogs`. */
function fakeLive() {
  let handlers: LiveHandlers<{ output: string }> | undefined;
  let closed = false;
  let teardownCount = 0;
  const calls: { project: string; tail: number }[] = [];

  const live: NonNullable<Backend['live']> = {
    stats: vi.fn(() => () => {}),
    logs: vi.fn(() => () => {}),
    composeLogs: vi.fn((project: string, tail: number, h: LiveHandlers<{ output: string }>) => {
      calls.push({ project, tail });
      handlers = h;
      closed = false;
      return () => {
        closed = true;
        teardownCount += 1;
      };
    }),
  };

  return {
    live,
    calls,
    emitData: (output: string) => handlers?.onData({ output }),
    emitEnd: (error?: string) => handlers?.onEnd(error),
    get closed() {
      return closed;
    },
    get teardownCount() {
      return teardownCount;
    },
  };
}

describe('useComposeLogsStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('PHP mode (no live): polls immediately and on the interval, never opens a stream', () => {
    const pollTick = vi.fn();
    const onContent = vi.fn();
    const controller = useComposeLogsStream(
      { getLive: () => undefined, getProjectName: () => 'demo', pollTick, pollIntervalMs: 3000 },
      { onContent },
    );

    controller.start();
    expect(pollTick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    expect(pollTick).toHaveBeenCalledTimes(2);
    expect(onContent).not.toHaveBeenCalled();

    controller.stop();
    vi.advanceTimersByTime(3000);
    expect(pollTick).toHaveBeenCalledTimes(2);
  });

  it('GraphQL mode: opens a stream instead of polling, with the configured project and tail', () => {
    const fake = fakeLive();
    const pollTick = vi.fn();
    const controller = useComposeLogsStream(
      { getLive: () => fake.live, getProjectName: () => 'media-stack', pollTick, tail: 250 },
      { onContent: vi.fn() },
    );

    controller.start();

    expect(fake.calls).toEqual([{ project: 'media-stack', tail: 250 }]);
    expect(pollTick).not.toHaveBeenCalled();
  });

  it('first chunk replaces content, later chunks append and clamp to maxLines', () => {
    const fake = fakeLive();
    const onContent = vi.fn();
    const controller = useComposeLogsStream(
      { getLive: () => fake.live, getProjectName: () => 'demo', pollTick: vi.fn(), maxLines: 3 },
      { onContent },
    );

    controller.start();
    fake.emitData('a\nb\nc');
    expect(onContent).toHaveBeenLastCalledWith('a\nb\nc');

    fake.emitData('d');
    expect(onContent).toHaveBeenLastCalledWith('b\nc\nd');
  });

  it('ignores an empty chunk', () => {
    const fake = fakeLive();
    const onContent = vi.fn();
    const controller = useComposeLogsStream(
      { getLive: () => fake.live, getProjectName: () => 'demo', pollTick: vi.fn() },
      { onContent },
    );

    controller.start();
    fake.emitData('');
    expect(onContent).not.toHaveBeenCalled();
  });

  it('on an unexpected end while active: falls back to polling and retries the stream after retryMs', () => {
    const fake = fakeLive();
    const pollTick = vi.fn();
    const controller = useComposeLogsStream(
      {
        getLive: () => fake.live,
        getProjectName: () => 'demo',
        pollTick,
        // Deliberately not a multiple of pollIntervalMs, so the retry timer
        // and a poll tick never land on the same fake-timer tick — keeping
        // this test's assertions independent of how ties between a timeout
        // and an interval due at the same instant happen to be ordered.
        retryMs: 16000,
        pollIntervalMs: 3000,
      },
      { onContent: vi.fn() },
    );

    controller.start();
    expect(fake.calls.length).toBe(1);

    fake.emitEnd('connection dropped');
    // Falls back to polling immediately.
    expect(pollTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(pollTick).toHaveBeenCalledTimes(2);

    // Not yet time to retry the stream.
    expect(fake.calls.length).toBe(1);

    vi.advanceTimersByTime(16000 - 3000);
    // The retry reopens the stream and (via start()'s stopInternal) stops polling.
    expect(fake.calls.length).toBe(2);
    const pollCountAtRetry = pollTick.mock.calls.length;

    vi.advanceTimersByTime(3000);
    // No more poll ticks once the stream has reopened.
    expect(pollTick).toHaveBeenCalledTimes(pollCountAtRetry);
  });

  it('does not fall back or retry when stop() was called before the stream ends', () => {
    const fake = fakeLive();
    const pollTick = vi.fn();
    const controller = useComposeLogsStream(
      { getLive: () => fake.live, getProjectName: () => 'demo', pollTick, retryMs: 15000 },
      { onContent: vi.fn() },
    );

    controller.start();
    controller.stop();
    expect(fake.closed).toBe(true);

    fake.emitEnd('closed by caller');
    vi.advanceTimersByTime(20000);
    expect(pollTick).not.toHaveBeenCalled();
    expect(fake.calls.length).toBe(1);
  });

  it('stop() closes an open stream and clears the poll timer', () => {
    const fake = fakeLive();
    const pollTick = vi.fn();
    const controllerWithStream = useComposeLogsStream(
      { getLive: () => fake.live, getProjectName: () => 'demo', pollTick },
      { onContent: vi.fn() },
    );
    controllerWithStream.start();
    controllerWithStream.stop();
    expect(fake.closed).toBe(true);

    const controllerWithPoll = useComposeLogsStream(
      { getLive: () => undefined, getProjectName: () => 'demo', pollTick, pollIntervalMs: 3000 },
      { onContent: vi.fn() },
    );
    controllerWithPoll.start();
    controllerWithPoll.stop();
    vi.advanceTimersByTime(10000);
    expect(pollTick).toHaveBeenCalledTimes(1); // only the immediate tick from start()
  });

  it('start() called again resets any prior stream/poll state before starting fresh', () => {
    const fake = fakeLive();
    const pollTick = vi.fn();
    const controller = useComposeLogsStream(
      { getLive: () => fake.live, getProjectName: () => 'demo', pollTick },
      { onContent: vi.fn() },
    );

    controller.start();
    expect(fake.calls.length).toBe(1);
    controller.start();
    expect(fake.teardownCount).toBe(1); // first stream torn down
    expect(fake.calls.length).toBe(2); // a fresh one opened
    expect(fake.closed).toBe(false); // ...and the fresh one is open
  });
});
