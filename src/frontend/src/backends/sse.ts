/**
 * Server-Sent-Events client for the PHP streaming endpoints
 * (`pull.php`, `compose-stream.php`).
 *
 * This is the fetch-and-parse loop that used to live inline in
 * `PullProgressModal.vue`, `BatchPullProgressModal.vue`, and
 * `ComposeProgressModal.vue`, moved out verbatim so `php.ts`'s
 * `streams.pull`/`streams.compose` and the GraphQL seam
 * (`graphqlStreams.ts`) can share one modal-facing shape:
 * `onEvent(event, data)`, called once per SSE event with `data` already
 * `JSON.parse`d.
 *
 * Raw `fetch()`, not `apiFetch()`: `pull.php`/`compose-stream.php` read the
 * CSRF token and every other field straight off `$_POST`, not wrapped in a
 * `payload` field the way `apiFetch()` re-wraps a JSON body. The caller
 * builds the exact `URLSearchParams` body PHP expects.
 */

/** Thrown when the response itself failed (`!response.ok`). Callers that want PHP's exact "HTTP {status}" text read `.message`; callers that want to treat this differently from other errors can `instanceof` it. */
export class SseHttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'SseHttpError';
  }
}

/** Thrown when the response has no readable body stream. */
export class SseNoStreamError extends Error {
  constructor() {
    super('No response stream');
    this.name = 'SseNoStreamError';
  }
}

export async function runSseStream(
  url: string,
  body: URLSearchParams,
  onEvent: (event: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });

  if (!response.ok) {
    throw new SseHttpError(response.status);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new SseNoStreamError();
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7);
      } else if (line.startsWith('data: ')) {
        try {
          onEvent(currentEvent, JSON.parse(line.slice(6)));
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
}
