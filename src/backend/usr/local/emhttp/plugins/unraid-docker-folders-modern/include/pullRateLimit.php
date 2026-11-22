<?php
/**
 * Retry for image pulls that a registry rate limits (HTTP 429).
 *
 * A pull goes through the Docker daemon, which talks to the registry. The
 * daemon reports a 429 as error text ("toomanyrequests: You have reached your
 * pull rate limit ...") and does not pass on the Retry-After header. Some
 * registries (lscr.io, ghcr.io) put a wait in the text as a Go duration
 * ("retry-after: 102.996µs"); Docker Hub's text has none. The wait is that
 * hint when present, never below a floor that grows with each attempt.
 *
 * The file only declares constants and functions and requires nothing.
 */

// Waits per attempt are capped, and so are the attempts, so a batch cannot
// hang. MAX_ATTEMPTS counts the first try: 4 means up to 3 retries.
const DFM_PULL_RATE_LIMIT_MAX_ATTEMPTS = 4;
const DFM_PULL_RATE_LIMIT_MAX_WAIT = 300;
// Minimum wait before attempts 2, 3 and 4 (the retries).
const DFM_PULL_RATE_LIMIT_FLOORS = [5, 15, 45];

/** True when a daemon or registry message reports a rate limit. */
function dfmIsRateLimitMessage($message)
{
  return (bool) preg_match('/toomanyrequests|too many requests|rate limit|http 429|status:? 429/i', (string) $message);
}

/**
 * Seconds (float) from a retry hint. Three forms: a Go duration such as
 * "102.996µs" or "1m42.5s" (what a registry puts in the 429 text), a bare
 * number of seconds, or an HTTP-date. Null when empty or not understood.
 */
function dfmParseRetryAfter($value, $now = null)
{
  $value = trim((string) $value);
  if ($value === '') return null;
  if (preg_match('/^\d+(?:\.\d+)?$/', $value)) return (float) $value;
  $units = ['h' => 3600, 'm' => 60, 's' => 1, 'ms' => 1e-3, 'us' => 1e-6, 'µs' => 1e-6, 'μs' => 1e-6, 'ns' => 1e-9];
  if (preg_match('/^(?:\d+(?:\.\d+)?(?:ms|us|µs|μs|ns|h|m|s))+$/u', $value)) {
    preg_match_all('/(\d+(?:\.\d+)?)(ms|us|µs|μs|ns|h|m|s)/u', $value, $parts, PREG_SET_ORDER);
    $total = 0.0;
    foreach ($parts as $part) $total += (float) $part[1] * $units[$part[2]];
    return $total;
  }
  if (!preg_match('/\d{2}:\d{2}:\d{2}/', $value)) return null; // a date has a clock time; strtotime reads "5min" as an offset
  $time = strtotime($value);
  if ($time === false) return null;
  return (float) max(0, $time - ($now ?? time()));
}

/**
 * Seconds to wait before the next try, capped at DFM_PULL_RATE_LIMIT_MAX_WAIT.
 * The wait is the larger of the registry's hint (when the message has one)
 * and a floor for the attempt (1 for the first failure). A hint of a few
 * microseconds means "now", but a batch that retries at once hits the
 * per-minute limit again, so the floor still applies.
 */
function dfmPullRateLimitDelay($message, $attempt)
{
  $floor = DFM_PULL_RATE_LIMIT_FLOORS[min(max($attempt, 1), count(DFM_PULL_RATE_LIMIT_FLOORS)) - 1];
  $hint = 0.0;
  if (preg_match('/retry[- ]after:?\s*(?:([A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)|(\d(?:[^\s,;]*[^\s,;.)\]])?))/i', (string) $message, $m)) {
    $hint = dfmParseRetryAfter($m[1] !== '' ? $m[1] : $m[2]) ?? 0.0;
  }
  return (int) min(DFM_PULL_RATE_LIMIT_MAX_WAIT, ceil(max($hint, $floor)));
}

/** The registry host of an image reference. No host in the name means Docker Hub. */
function dfmImageRegistry($image)
{
  $first = explode('/', (string) $image, 2);
  if (count($first) === 2 && (strpos($first[0], '.') !== false || strpos($first[0], ':') !== false || $first[0] === 'localhost')) {
    return strtolower($first[0]);
  }
  return 'docker.io';
}

/** One state file per registry: a limit on Docker Hub must not stall ghcr.io pulls. */
function dfmPullRateLimitStatePath($registry = 'docker.io')
{
  return sys_get_temp_dir() . '/unraid-docker-folders-pull-ratelimit-' . md5($registry);
}

/**
 * Run one pull with retry on a rate limit. One rate limit usually hits the
 * rest of a batch too, so the wait is shared: the deadline goes to a state
 * file, and any pull that starts before it waits for it instead of failing.
 *
 * @param callable $attempt    fn(callable $emit, bool $holdRateLimit): bool. When
 *                             $holdRateLimit is true it must not pass a rate
 *                             limit error line to $emit, because a retry follows.
 * @param callable $getError   fn(): string, the failure text of the last attempt
 * @param callable $onProgress receives status chunks, like pullImage()'s callback
 * @param callable|null $sleep fn(int $seconds), for tests
 * @param string|null $statePath state file, for tests
 * @param callable|null $now   fn(): int, for tests
 * @param string $registry     registry host that shares the wait, from dfmImageRegistry()
 */
function dfmRunPullWithRateLimitRetry(callable $attempt, callable $getError, callable $onProgress, $sleep = null, $statePath = null, $now = null, $registry = 'docker.io')
{
  $sleep = $sleep ?? 'sleep';
  $now = $now ?? 'time';
  $statePath = $statePath ?? dfmPullRateLimitStatePath($registry);

  $wait = function ($seconds, $label) use ($sleep, $onProgress) {
    $onProgress(['id' => '', 'status' => "{$label}, retrying in {$seconds}s"]);
    $sleep($seconds);
  };

  for ($try = 1; $try <= DFM_PULL_RATE_LIMIT_MAX_ATTEMPTS; $try++) {
    $left = (int) @file_get_contents($statePath) - $now();
    if ($left > 0) {
      $wait(min($left, DFM_PULL_RATE_LIMIT_MAX_WAIT), 'Waiting for a registry rate limit');
    }

    $last = $try === DFM_PULL_RATE_LIMIT_MAX_ATTEMPTS;
    if ($attempt($onProgress, !$last)) return true;

    $error = $getError();
    if ($last || !dfmIsRateLimitMessage($error)) return false;

    $deadline = max((int) @file_get_contents($statePath), $now() + dfmPullRateLimitDelay($error, $try));
    @file_put_contents($statePath, (string) $deadline, LOCK_EX);
    $wait(max(1, $deadline - $now()), 'Rate limited by the registry');
  }
  return false;
}
