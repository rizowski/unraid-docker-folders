<?php
/**
 * Retry for image pulls that a registry rate limits (HTTP 429).
 *
 * A pull goes through the Docker daemon, which talks to the registry. The
 * daemon reports a 429 as error text ("toomanyrequests: You have reached your
 * pull rate limit ...") and does not pass on the Retry-After header. So the
 * wait is read from the text when the text names one, and is a bounded
 * backoff otherwise. parseRetryAfter() reads both header forms for a caller
 * that does see the header.
 *
 * The file only declares constants and functions and requires nothing.
 */

// Waits per attempt are capped, and so are the attempts, so a batch cannot
// hang. MAX_ATTEMPTS counts the first try: 4 means up to 3 retries.
const DFM_PULL_RATE_LIMIT_MAX_ATTEMPTS = 4;
const DFM_PULL_RATE_LIMIT_MAX_WAIT = 300;
const DFM_PULL_RATE_LIMIT_BASE_WAIT = 30;

/** True when a daemon or registry message reports a rate limit. */
function dfmIsRateLimitMessage($message)
{
  return (bool) preg_match('/toomanyrequests|too many requests|rate limit|http 429|status:? 429/i', (string) $message);
}

/**
 * Seconds from a Retry-After value: a number of seconds or an HTTP-date.
 * Null when the value is empty or not understood.
 */
function parseRetryAfter($value, $now = null)
{
  $value = trim((string) $value);
  if ($value === '') return null;
  if (ctype_digit($value)) return (int) $value;
  $time = strtotime($value);
  if ($time === false) return null;
  return max(0, $time - ($now ?? time()));
}

/**
 * Seconds to wait before the next try, capped at DFM_PULL_RATE_LIMIT_MAX_WAIT.
 * A "retry after 45" or "Retry-After: 45" in the message wins; otherwise
 * 30s, 60s, 120s... by attempt number (1 for the first failure).
 */
function dfmPullRateLimitDelay($message, $attempt)
{
  $seconds = preg_match('/retry[- ]after:?\s*(\d+)/i', (string) $message, $m)
    ? (int) $m[1]
    : DFM_PULL_RATE_LIMIT_BASE_WAIT * (2 ** ($attempt - 1));
  return max(1, min(DFM_PULL_RATE_LIMIT_MAX_WAIT, $seconds));
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
