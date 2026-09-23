import { describe, it, expect, afterEach, vi } from 'vitest';
import { runSseStream, SseHttpError, SseNoStreamError } from '../sse';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A `Response`-like object streaming the given SSE text as one chunk. */
function sseResponse(text: string, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return { ok: status >= 200 && status < 300, status, body } as unknown as Response;
}

describe('runSseStream', () => {
  it('parses event/data pairs in order, JSON-decoding each data line', async () => {
    const events: Array<[string, unknown]> = [];
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse(
        'event: status\ndata: {"message":"Pulling..."}\n\n' +
          'event: complete\ndata: {"message":"done","image":"plex"}\n\n' +
          'event: done\ndata: {"finished":true}\n\n',
      ),
    );

    await runSseStream('/x', new URLSearchParams(), (e, d) => events.push([e, d]), new AbortController().signal);

    expect(events).toEqual([
      ['status', { message: 'Pulling...' }],
      ['complete', { message: 'done', image: 'plex' }],
      ['done', { finished: true }],
    ]);
  });

  it('sends the body and headers pull.php/compose-stream.php expect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(''));
    globalThis.fetch = fetchMock;

    const body = new URLSearchParams({ csrf_token: 'abc', recreate: '1' });
    await runSseStream('/api/pull.php?image=x', body, () => {}, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith('/api/pull.php?image=x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'csrf_token=abc&recreate=1',
      signal: expect.any(AbortSignal),
    });
  });

  it('skips a malformed data line without throwing', async () => {
    const events: Array<[string, unknown]> = [];
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse('event: progress\ndata: {not json}\n\nevent: done\ndata: {"finished":true}\n\n'),
    );

    await runSseStream('/x', new URLSearchParams(), (e, d) => events.push([e, d]), new AbortController().signal);

    expect(events).toEqual([['done', { finished: true }]]);
  });

  it('throws SseHttpError with the exact "HTTP {status}" text on a non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse('', 404));

    await expect(
      runSseStream('/x', new URLSearchParams(), () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ message: 'HTTP 404' });
    await expect(
      runSseStream('/x', new URLSearchParams(), () => {}, new AbortController().signal),
    ).rejects.toBeInstanceOf(SseHttpError);
  });

  it('throws SseNoStreamError when the response has no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response);

    await expect(
      runSseStream('/x', new URLSearchParams(), () => {}, new AbortController().signal),
    ).rejects.toBeInstanceOf(SseNoStreamError);
    await expect(
      runSseStream('/x', new URLSearchParams(), () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ message: 'No response stream' });
  });

  it('propagates an AbortError from fetch unchanged', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(
      runSseStream('/x', new URLSearchParams(), () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
