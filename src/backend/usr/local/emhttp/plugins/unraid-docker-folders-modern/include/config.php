<?php
/**
 * Unraid Docker Folders - Configuration
 *
 * @package UnraidDockerModern
 */

// Plugin information
define('PLUGIN_NAME', 'unraid-docker-folders-modern');
define('PLUGIN_VERSION', '1.0.0');
define('PLUGIN_AUTHOR', 'rizowski');

// Paths
define('PLUGIN_DIR', '/usr/local/emhttp/plugins/' . PLUGIN_NAME);
define('CONFIG_DIR', '/boot/config/plugins/' . PLUGIN_NAME);
define('DATA_DIR', CONFIG_DIR . '/data');
define('BACKUP_DIR', CONFIG_DIR . '/backups');

// Compose stacks storage (self-contained copies of imported compose files)
define('COMPOSE_STACKS_DIR', CONFIG_DIR . '/compose-stacks');

// Roots that user-supplied paths are allowed to point into.
//
// /mnt covers Unraid user shares and appdata, which is where compose stacks and
// backups genuinely live. Everything outside these roots is rejected — notably
// /etc, /root, and /var/local/emhttp/var.ini, which holds the CSRF token.
//
// A stack's own working_dir is allowed in addition to COMPOSE_ALLOWED_ROOTS, but
// it is passed per-call rather than listed here because it varies per stack.
define('COMPOSE_ALLOWED_ROOTS', ['/mnt', COMPOSE_STACKS_DIR]);
define('EXPORT_ALLOWED_ROOTS', ['/mnt', CONFIG_DIR]);
define('BACKUP_ALLOWED_ROOTS', ['/mnt', '/boot/config/plugins']);

// Sort modes for folders and folder contents. Must match SortMode in
// src/frontend/src/types/folder.ts.
define('SORT_MODES', ['manual', 'name-asc', 'name-desc', 'status', 'created-asc', 'created-desc']);
define('BACKEND_MODES', ['php', 'graphql']);
define('GRAPHQL_PLUGIN_NAME', 'unraid-api-plugin-docker-folders');
define('UNRAID_API_DIR', '/usr/local/unraid-api');
define('UNRAID_API_SOCKET', '/var/run/unraid-api.sock');

// Database
define('DB_PATH', CONFIG_DIR . '/data.db');

// Schedule runner heartbeat. scripts/run-schedules.php touches this on every
// cron invocation, and api/schedules.php reports its mtime so the UI can tell
// the user when the runner stopped firing. /var/run is in RAM on purpose —
// DB_PATH lives on the USB flash device, and a heartbeat row would write to it
// every 60 seconds forever.
define('SCHEDULER_TICK_FILE', '/var/run/' . PLUGIN_NAME . '.tick');
// Older than this and the runner counts as stale. Two missed minutes, so a
// single slow tick does not raise a warning.
define('SCHEDULER_TICK_STALE_SECONDS', 300);
// Last time the plugin rewrote its cron file to repair a missing runner entry.
// The repair writes to CONFIG_DIR, which is the USB flash device, so a box
// where the repair cannot succeed must not write flash on every load of the
// schedules screen. One attempt per stale window is enough.
define('SCHEDULER_REPAIR_FILE', '/var/run/' . PLUGIN_NAME . '.repair');

// Logging
define('UPDATE_LOG_PATH', CONFIG_DIR . '/update-check.log');
define('UPDATE_LOG_MAX_BYTES', 64 * 1024); // 64 KB max

// Docker
// Guarded: DockerClient.php is loadable without config.php (tests define these
// directly so the class can be exercised in isolation), so config.php must not
// redefine them when both end up in the same process.
if (!defined('DOCKER_SOCKET')) {
  define('DOCKER_SOCKET', '/var/run/docker.sock');
}
if (!defined('DOCKER_API_VERSION')) {
  define('DOCKER_API_VERSION', 'v1.41');
}

// nchan WebSocket
//
// The publisher listens on a Unix socket, not on a TCP port. `conf.d/servers.conf`
// sets `listen unix:/var/run/nginx.socket` for the `/pub/` locations, and nothing
// listens on localhost:4433, which is what this constant used to say. Every
// publish therefore failed and live updates fell back to the 30-second poll.
//
// `buffer_length` is required, not optional. The location sets
// `nchan_message_buffer_length $arg_buffer_length`, so without the query
// parameter the buffer length is empty and nchan answers 403 instead of 201.
//
// `/usr/local/emhttp/plugins/dynamix/include/publish.php` is Unraid's own
// publisher and is where this shape comes from.
define('NCHAN_SOCKET_PATH', '/var/run/nginx.socket');
define('NCHAN_PUB_URL', 'http://localhost/pub/docker-modern?buffer_length=1');
define('NCHAN_SUB_PATH', '/sub/docker-modern');

// Error reporting (disable in production)
if (defined('DEBUG') && DEBUG) {
  error_reporting(E_ALL);
  ini_set('display_errors', '1');
} else {
  error_reporting(0);
  ini_set('display_errors', '0');
}

// Timezone
//
// Schedules (cron expressions) are entered by the user in server-local time,
// and ScheduleManager::computeNextRun() uses date()/mktime() under whatever
// zone PHP is set to. If we stayed pinned to UTC, a schedule entered as
// "15:30" would run at 15:30 UTC instead of 15:30 in the user's own Unraid
// timezone. So adopt the Unraid-configured zone instead.
/**
 * Determine the timezone Unraid itself is configured for.
 *
 * Tries, in order:
 *   1. The `timeZone` key Unraid writes to ident.cfg (e.g. `timeZone="America/Denver"`).
 *   2. The target of the /etc/localtime symlink, which Unraid also maintains,
 *      read as the path segment after "zoneinfo/".
 *   3. UTC, if neither yields a timezone identifier PHP recognizes.
 *
 * @param string $identCfg  Path to ident.cfg (overridable for tests).
 * @param string $localtime Path to the localtime symlink (overridable for tests).
 * @return string A valid PHP timezone identifier.
 */
function detectServerTimezone($identCfg = '/boot/config/ident.cfg', $localtime = '/etc/localtime') {
  // Memoised per path pair: config.php is loaded on every request, including
  // the stats poll, and the answer cannot change within one process.
  static $cache = [];
  $key = $identCfg . '|' . $localtime;
  if (isset($cache[$key])) {
    return $cache[$key];
  }

  $candidates = [];

  if (is_readable($identCfg)) {
    $ident = @parse_ini_file($identCfg);
    if (is_array($ident) && !empty($ident['timeZone'])) {
      $candidates[] = $ident['timeZone'];
    }
  }

  // readlink() returns false for a missing path or a non-symlink.
  $target = @readlink($localtime);
  if ($target !== false && preg_match('#zoneinfo/(.+)$#', $target, $matches)) {
    $candidates[] = $matches[1];
  }

  $validZones = DateTimeZone::listIdentifiers();
  $zone = 'UTC';
  foreach ($candidates as $candidate) {
    if (in_array($candidate, $validZones, true)) {
      $zone = $candidate;
      break;
    }
  }

  return $cache[$key] = $zone;
}

date_default_timezone_set(detectServerTimezone());

require_once __DIR__ . '/paths.php';
require_once dirname(__DIR__) . '/classes/ReleaseNotes.php';

/**
 * Read a request flag as a boolean.
 *
 * JSON sends true or false, but a form sends strings, and !empty() reads the
 * string "false" as true. This accepts a bool, a number, or the strings that
 * FILTER_VALIDATE_BOOLEAN knows ("1", "true", "on", "yes" and their opposites).
 * Anything else is false.
 *
 * @param mixed $value
 * @return bool
 */
function requestFlag($value)
{
  if (is_bool($value)) {
    return $value;
  }
  if (is_int($value) || is_float($value)) {
    return $value != 0;
  }
  if (is_string($value)) {
    return filter_var(trim($value), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? false;
  }
  return false;
}

/**
 * Read JSON request data from the request body.
 * Checks $_POST['payload'] first (form-encoded alongside csrf_token),
 * then parses php://input as URL-encoded (for PUT/DELETE where PHP
 * doesn't populate $_POST), falls back to raw JSON.
 *
 * Requires auth.php to be loaded first (for getRawBody()).
 *
 * @return array|null Decoded JSON data or null on failure
 */
function getRequestData()
{
  if (isset($_POST['payload'])) {
    return json_decode($_POST['payload'], true);
  }

  // Use getRawBody() (cached in auth.php) since php://input can only be read once
  $raw = getRawBody();

  // Check if the raw body is URL-encoded (contains payload= field)
  if ($raw && strpos($raw, 'payload=') !== false) {
    parse_str($raw, $parsed);
    if (isset($parsed['payload'])) {
      return json_decode($parsed['payload'], true);
    }
  }

  return json_decode($raw, true);
}

/**
 * Append a timestamped line to the update check log.
 * Truncates the log if it exceeds UPDATE_LOG_MAX_BYTES.
 *
 * @param string $message Log message
 */
function logUpdate($message)
{
  $line = '[' . date('Y-m-d H:i:s') . '] ' . $message . "\n";
  file_put_contents(UPDATE_LOG_PATH, $line, FILE_APPEND | LOCK_EX);

  if (file_exists(UPDATE_LOG_PATH) && filesize(UPDATE_LOG_PATH) > UPDATE_LOG_MAX_BYTES) {
    $content = file_get_contents(UPDATE_LOG_PATH);
    $keep = substr($content, -intval(UPDATE_LOG_MAX_BYTES * 0.75));
    $pos = strpos($keep, "\n");
    if ($pos !== false) {
      $keep = substr($keep, $pos + 1);
    }
    file_put_contents(UPDATE_LOG_PATH, $keep, LOCK_EX);
  }
}

/**
 * One image's entry in an update-check response.
 *
 * Kept as a single defaulted shape because the same nine keys are also
 * produced by the error path and read by api/updates.php, the frontend's
 * ImageUpdateStatus, and the dev mock. A field added here reaches every
 * caller at once instead of rotting in whichever branch was forgotten —
 * historically the \Throwable branch, which nothing exercises field by field.
 *
 * Deliberately not shared with the SQLite upsert: that binds
 * `update_available` as 1/0, while the response keeps it a real bool.
 *
 * @param string $image
 * @param array $overrides
 * @return array
 */
function imageCheckResult($image, array $overrides = [])
{
  return array_merge([
    'image' => $image,
    'local_digest' => null,
    'remote_digest' => null,
    'update_available' => false,
    'checked_at' => time(),
    'error' => null,
    'source_url' => null,
    'source_repo' => null,
    'release' => null,
  ], $overrides);
}

/**
 * Check container images for updates against their registries.
 *
 * Shared logic used by both the cron script and the manual API endpoint.
 * Loads exclude patterns, collects unique images, checks each, and upserts results.
 *
 * @param DockerClient $dockerClient Docker API client
 * @param Database $db Database instance
 * @param callable $log Logging callback: function(string $message)
 * @param array|null $onlyImages Restrict the check to these image references
 *                               (e.g. one container's image, or a compose
 *                               stack's images). Null checks everything.
 * @return array ['results' => [...], 'checked' => int, 'skipped' => int, 'errors' => int, 'newUpdates' => int]
 */
function checkAllImageUpdates($dockerClient, $db, callable $log, $onlyImages = null)
{
  $containers = $dockerClient->listContainers(true);

  // Load exclude patterns from settings
  $excludePatterns = [];
  $excludeRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'update_check_exclude'");
  if ($excludeRow && !empty($excludeRow['value'])) {
    $excludePatterns = array_map('trim', explode(',', $excludeRow['value']));
    $excludePatterns = array_filter($excludePatterns, function ($p) { return $p !== ''; });
  }

  // Collect unique images, and which containers run each one. The notification
  // names containers, not images, so the caller needs the reverse map.
  $uniqueImages = [];
  $containersByImage = [];
  foreach ($containers as $container) {
    $image = $container['image'] ?? '';
    $imageId = $container['imageId'] ?? '';
    if ($image && !isset($uniqueImages[$image])) {
      $uniqueImages[$image] = $imageId;
    }
    $name = $container['name'] ?? '';
    if ($image && $name !== '') {
      $containersByImage[$image][] = $name;
    }
  }

  // Targeted check: restrict to the requested images. Only images that
  // actually belong to a container are checked — unknown names are ignored.
  if ($onlyImages !== null) {
    $requested = array_fill_keys(array_map('strval', $onlyImages), true);
    $uniqueImages = array_intersect_key($uniqueImages, $requested);
    $log('INFO Targeted check for ' . count($onlyImages) . ' image(s), ' . count($uniqueImages) . ' matched running container image(s)');
  }

  $log('INFO Found ' . count($containers) . ' container(s), ' . count($uniqueImages) . ' unique image(s)');

  $results = [];
  $checked = 0;
  $skipped = 0;
  $errors = 0;
  $newUpdates = 0;

  foreach ($uniqueImages as $imageName => $imageId) {
    // Skip excluded images
    $excluded = false;
    foreach ($excludePatterns as $pattern) {
      if (fnmatch($pattern, $imageName)) {
        $excluded = true;
        break;
      }
    }
    if ($excluded) {
      $log('SKIP ' . $imageName . ' (excluded)');
      $skipped++;
      continue;
    }

    // Counted once, before the try. An exception after the count used to be
    // counted again in the catch, so the image showed up twice in the total.
    $checked++;

    // Wrap each image check in try/catch so one failure doesn't kill the loop
    try {
      $check = $dockerClient->checkImageUpdate($imageName, $imageId);

      // Suppress false positives: if we previously marked this image as
      // up-to-date (e.g. after a pull) and the remote digest hasn't changed,
      // the image is still current. This handles multi-arch images where
      // local RepoDigest format differs from distribution API digest.
      if ($check['update_available'] && !$check['error'] && $check['remote_digest']) {
        $existing = $db->fetchOne(
          'SELECT remote_digest, update_available FROM image_update_checks WHERE image = ?',
          [$imageName]
        );
        if ($existing
            && $existing['update_available'] == 0
            && $existing['remote_digest']
            && $existing['remote_digest'] === $check['remote_digest']) {
          $check['update_available'] = false;
          $log('OK ' . $imageName . ': remote digest unchanged since last pull, no update');
        }
      }

      if ($check['error']) {
        $log('ERROR ' . $imageName . ': ' . $check['error']);
        $errors++;
      } elseif ($check['update_available']) {
        $log('UPDATE ' . $imageName . ': update available');
        $newUpdates++;
      } else {
        $log('OK ' . $imageName . ': up to date');
      }

      // Normalised GitHub repo, used to join cached release notes.
      $sourceRepo = ReleaseNotes::parseRepo($check['source_url'] ?? null);

      // Upsert into database
      $db->query(
        'INSERT OR REPLACE INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at, error, source_url, source_repo)
         VALUES (:image, :local_digest, :remote_digest, :update_available, :checked_at, :error, :source_url, :source_repo)',
        [
          ':image' => $imageName,
          ':local_digest' => $check['local_digest'],
          ':remote_digest' => $check['remote_digest'],
          ':update_available' => $check['update_available'] ? 1 : 0,
          ':checked_at' => time(),
          ':error' => $check['error'],
          ':source_url' => $check['source_url'] ?? null,
          ':source_repo' => $sourceRepo,
        ]
      );

      $results[$imageName] = imageCheckResult($imageName, [
        'local_digest' => $check['local_digest'],
        'remote_digest' => $check['remote_digest'],
        'update_available' => $check['update_available'],
        'error' => $check['error'],
        'source_url' => $check['source_url'] ?? null,
        'source_repo' => $sourceRepo,
      ]);
    } catch (\Throwable $e) {
      $log('FATAL ' . $imageName . ': ' . $e->getMessage());
      $errors++;
      $results[$imageName] = imageCheckResult($imageName, ['error' => $e->getMessage()]);
    }
  }

  // Clean up stale entries for images that no longer have containers
  // (e.g. after container recreation changed the image reference).
  // Skipped for targeted checks: $uniqueImages only holds the requested
  // subset there, so the NOT IN clause would wipe every other image's row.
  $currentImages = array_keys($uniqueImages);
  if ($onlyImages === null && !empty($currentImages)) {
    $placeholders = implode(',', array_fill(0, count($currentImages), '?'));
    $staleCount = $db->fetchValue(
      "SELECT COUNT(*) FROM image_update_checks WHERE image NOT IN ({$placeholders})",
      array_values($currentImages)
    );
    if ($staleCount > 0) {
      $db->query(
        "DELETE FROM image_update_checks WHERE image NOT IN ({$placeholders})",
        array_values($currentImages)
      );
      $log('CLEANUP Removed ' . $staleCount . ' stale image_update_checks entries');
    }
  }

  // Release notes are a nice-to-have layered on top of a complete check. Any
  // failure here — network, schema, anything — must leave the digest results
  // and the counters below exactly as they are.
  try {
    refreshReleaseNotes($results, $db, $log, $onlyImages === null);
  } catch (\Throwable $e) {
    $log('NOTES FATAL ' . $e->getMessage());
  }

  return [
    'results' => $results,
    'checked' => $checked,
    'skipped' => $skipped,
    'errors' => $errors,
    'newUpdates' => $newUpdates,
    'containersByImage' => $containersByImage,
  ];
}

/**
 * Compose the Unraid notification for newly available updates.
 *
 * Counts containers rather than images (one image can back several
 * containers) and names them in the description, capped so a big server does
 * not produce a wall of text.
 *
 * @param string[] $newImages Images that flipped to update-available this run
 * @param array<string, string[]> $containersByImage Image => container names
 * @return array{subject: string, description: string}|null Null when no container uses a new image
 */
function buildUpdateNotification(array $newImages, array $containersByImage)
{
  $maxNames = 10;
  $names = [];
  foreach ($newImages as $image) {
    foreach ($containersByImage[$image] ?? [] as $name) {
      $names[$name] = true;
    }
  }
  $names = array_keys($names);
  if (empty($names)) {
    return null;
  }
  sort($names, SORT_NATURAL | SORT_FLAG_CASE);

  $count = count($names);
  $subject = $count . ' container update' . ($count === 1 ? '' : 's') . ' available';

  $shown = array_slice($names, 0, $maxNames);
  $description = implode(', ', $shown);
  $rest = $count - count($shown);
  if ($rest > 0) {
    $description .= ' and ' . $rest . ' more';
  }

  return ['subject' => $subject, 'description' => $description];
}

/**
 * Compose the Unraid notification for a failed automatic schedule run.
 *
 * @param array $schedule A schedule row, or a run result carrying name,
 *   target_type, target_id and action
 * @param string $message The error the run reported
 * @return array{subject: string, description: string}
 */
function buildScheduleFailureNotification(array $schedule, $message)
{
  $name = trim((string) ($schedule['name'] ?? ''));
  $reason = trim((string) $message);
  if ($reason === '') {
    $reason = 'Unknown error';
  }

  $action = (string) ($schedule['action'] ?? '');
  if ($action === 'backup') {
    $description = 'Backup failed: ' . $reason;
  } else {
    $kind = ($schedule['target_type'] ?? '') === 'stack' ? 'stack' : 'container';
    $target = (string) ($schedule['target_id'] ?? '');
    $description = "Could not {$action} {$kind} {$target}: {$reason}";
  }

  return [
    'subject' => 'Schedule failed: ' . ($name !== '' ? $name : 'unnamed schedule'),
    'description' => $description,
  ];
}

/**
 * Render a lateness in whole minutes and hours, e.g. "6h 40m".
 *
 * Both the skipped-run history message and the notification read this, and
 * tests assert on the exact text, so keep one formatter.
 *
 * @param int $seconds How late the run was
 * @return string
 */
function formatRunLateness($seconds)
{
  $seconds = max(0, (int) $seconds);
  $minutes = intdiv($seconds, 60);
  $hours = intdiv($minutes, 60);
  $minutes = $minutes % 60;

  if ($hours > 0) {
    return "{$hours}h {$minutes}m";
  }
  if ($minutes > 0) {
    return "{$minutes}m";
  }
  return "{$seconds}s";
}

/**
 * Build the notification for a run that was skipped because it was overdue.
 *
 * A skip is news, not a failure: nothing broke, an action was deliberately not
 * taken. The runner sends this at 'normal' importance, not 'warning'.
 *
 * @param array $schedule Row-shaped array carrying at least name,
 *   target_type, target_id and action
 * @param int $lateBySeconds How far past the scheduled time the runner found it
 * @return array{subject: string, description: string}
 */
function buildScheduleSkipNotification(array $schedule, $lateBySeconds)
{
  $name = trim((string) ($schedule['name'] ?? ''));
  $late = formatRunLateness($lateBySeconds);
  $action = (string) ($schedule['action'] ?? '');
  $kind = ($schedule['target_type'] ?? '') === 'stack' ? 'stack' : 'container';
  $target = (string) ($schedule['target_id'] ?? '');

  return [
    'subject' => 'Schedule skipped: ' . ($name !== '' ? $name : 'unnamed schedule'),
    'description' => "Did not {$action} {$kind} {$target}: the run was {$late} past its scheduled time."
      . ' The schedule runner was not active when it came due.',
  ];
}

/**
 * Post a notification through Unraid's notify script. Every value goes
 * through escapeshellarg().
 *
 * @param string $importance normal, warning, or alert
 */
function sendUnraidNotification($subject, $description, $importance = 'normal')
{
  $cmd = '/usr/local/emhttp/webGui/scripts/notify'
    . ' -e ' . escapeshellarg('Docker Folders')
    . ' -s ' . escapeshellarg($subject)
    . ' -d ' . escapeshellarg($description)
    . ' -i ' . escapeshellarg($importance)
    . ' -l ' . escapeshellarg('/Docker/Folders');
  exec($cmd);
}

/**
 * Refresh and attach cached GitHub release notes for the checked images.
 *
 * Fetching is gated on update_available (no point spending a request on an
 * image nobody is about to pull), but *decoration* is not: any image with a
 * cached row gets its release attached. That keeps the POST response shaped
 * identically to the GET one, which matters because the frontend store
 * wholesale-replaces its state from either.
 *
 * @param array $results Per-image results, mutated in place
 * @param Database $db Database instance
 * @param callable $log Logging callback
 * @param bool $full True for a full check (enables GC of orphaned rows)
 * @param int|null $now Current timestamp; injectable for tests
 * @param callable|null $fetcher Fetch callback; injectable so tests run offline
 */
function refreshReleaseNotes(array &$results, $db, callable $log, $full, $now = null, $fetcher = null)
{
  $now = $now ?? time();
  $fetcher = $fetcher ?? ['ReleaseNotes', 'fetchLatest'];

  // repo => whether any image on that repo actually has an update pending
  $candidates = [];
  foreach ($results as $info) {
    $repo = $info['source_repo'] ?? null;
    if ($repo === null || $repo === '') {
      continue;
    }
    $candidates[$repo] = ($candidates[$repo] ?? false) || !empty($info['update_available']);
  }

  if (empty($candidates)) {
    return;
  }

  $repos = array_keys($candidates);
  $placeholders = implode(',', array_fill(0, count($repos), '?'));

  // Full rows, not just the staleness columns: the fetch loop below keeps this
  // map current as it writes, so it doubles as the source for the decoration
  // pass and saves re-reading the same rows back out.
  $rows = [];
  foreach ($db->fetchAll("SELECT * FROM release_notes WHERE repo IN ({$placeholders})", $repos) as $row) {
    $rows[$row['repo']] = $row;
  }

  // Stale = pending an update, and either never fetched or past its TTL.
  $stale = [];
  foreach ($candidates as $repo => $pending) {
    if (!$pending) {
      continue;
    }
    $row = $rows[$repo] ?? null;
    if ($row === null) {
      $stale[$repo] = 0;
      continue;
    }
    $fetchedAt = (int) $row['fetched_at'];
    if ($now - $fetchedAt >= ReleaseNotes::ttlFor($row['status'] ?? 'ok')) {
      $stale[$repo] = $fetchedAt;
    }
  }

  // Oldest first. Without the ordering the same repos win the cap every run
  // and anything past the cap would never get notes at all.
  asort($stale);
  $toFetch = array_slice(array_keys($stale), 0, ReleaseNotes::MAX_FETCHES_PER_RUN);
  if (count($stale) > count($toFetch)) {
    $log('NOTES CAP ' . count($toFetch) . ' of ' . count($stale) . ' stale repo(s) this run');
  }

  $start = time();
  foreach ($toFetch as $repo) {
    if (time() - $start >= ReleaseNotes::MAX_WALL_SECONDS) {
      $log('NOTES BUDGET Wall-clock budget reached, deferring remaining repo(s)');
      break;
    }

    $result = call_user_func($fetcher, $repo);
    $status = $result['status'] ?? 'error';

    // Deliberately write nothing on a rate-limit: caching an empty row would
    // suppress notes for this repo for hours because of a transient 403.
    if ($status === 'rate_limited') {
      $log('NOTES RATE-LIMIT GitHub budget exhausted, skipping remaining repo(s)');
      break;
    }

    $release = $status === 'ok' ? ($result['release'] ?? null) : null;

    $row = [
      'repo' => $repo,
      'tag' => $release['tag'] ?? null,
      'name' => $release['name'] ?? null,
      'published_at' => $release['published_at'] ?? null,
      'url' => $release['url'] ?? null,
      'summary' => $release['summary'] ?? null,
      'status' => in_array($status, ['ok', 'not_found'], true) ? $status : 'error',
      'fetched_at' => $now,
    ];

    // release_notes.etag is left out. It was a placeholder for conditional
    // requests that were never built, and PHP only ever wrote NULL into it,
    // which REPLACE also leaves there. The column stays, because the Unraid
    // API plugin writes the same table and still names it.
    $db->query(
      'INSERT OR REPLACE INTO release_notes (repo, tag, name, published_at, url, summary, status, fetched_at)
       VALUES (:repo, :tag, :name, :published_at, :url, :summary, :status, :fetched_at)',
      [
        ':repo' => $row['repo'],
        ':tag' => $row['tag'],
        ':name' => $row['name'],
        ':published_at' => $row['published_at'],
        ':url' => $row['url'],
        ':summary' => $row['summary'],
        ':status' => $row['status'],
        ':fetched_at' => $row['fetched_at'],
      ]
    );
    $rows[$repo] = $row;

    if ($status === 'ok') {
      $log('NOTES OK ' . $repo . ' ' . ($release['tag'] ?? '(untagged)'));
    } elseif ($status === 'not_found') {
      $log('NOTES 404 ' . $repo . ': no releases published');
    } else {
      $log('NOTES ERROR ' . $repo . ': HTTP ' . ($result['http'] ?? 0));
    }
  }

  // Decorate every image from $rows, which the fetch loop kept current.
  foreach ($results as $image => $info) {
    $repo = $info['source_repo'] ?? null;
    $results[$image]['release'] = $repo !== null && isset($rows[$repo])
      ? ReleaseNotes::payload($rows[$repo])
      : null;
  }

  // Drop notes for repos no container references any more. Skipped on a
  // targeted check, where $results only holds the requested subset.
  if ($full) {
    $db->query(
      'DELETE FROM release_notes
        WHERE repo NOT IN (SELECT source_repo FROM image_update_checks WHERE source_repo IS NOT NULL)'
    );
  }
}

/**
 * Cache-busting query value for a plugin file served under a fixed URL: the
 * CodeMirror vendor files, frameSrc.js, and the iframe entry documents
 * assets/index.html and assets/widget.html. Vite content-hashes the chunks
 * those documents reference, but not the documents themselves, so a cached
 * index.html keeps pointing at chunk names emptyOutDir already deleted.
 *
 * Unraid's nginx serves these files directly and the plugin ships no nginx
 * config, so PHP cannot set cache headers on them. The query string is the
 * only part of the URL a page file can move.
 *
 * filemtime() rather than a version constant: build.sh copies the backend
 * tree with `cp -r`, so every packaged file gets a fresh mtime, and this
 * also busts after an in-place SSH edit during debugging.
 *
 * @param string $absolutePath Absolute path to the asset.
 * @return string The file's mtime, or PLUGIN_VERSION when it is unreadable.
 */
function dfmAssetVersion($absolutePath)
{
  $mtime = @filemtime($absolutePath);
  return $mtime !== false ? (string) $mtime : PLUGIN_VERSION;
}

/**
 * Which backend the Vue app should talk to: 'php' or 'graphql'.
 *
 * The selector lives here rather than in the GraphQL backend on purpose. PHP
 * is always present, so the setting is always readable; storing it in the
 * backend being selected would be circular.
 *
 * Fails to 'php' on any error. A database that is missing, locked, or holding
 * a value we do not recognise must not leave the frontend without a
 * transport. The page files pass the result to the iframe as a query param,
 * because a global set here belongs to the parent document.
 */
/**
 * Reduce a stored or submitted backend mode to one we can serve.
 *
 * Both readers need this: `dfmBackendMode()` for pages that have not loaded
 * settings, and `DockerFolders.page`, which already has them in an array.
 */
function dfmNormalizeBackendMode($mode)
{
  return in_array($mode, BACKEND_MODES, true) ? $mode : 'php';
}

/**
 * The stored backend mode, or null when it could not be read.
 *
 * Distinct from dfmBackendMode() because one caller must not treat "could not
 * read" as "php". The busy timeout matters: while the plugin writes the same
 * database, a read without one fails at once, and the schedule runner took
 * that failure for PHP mode and fired a backup the plugin was already
 * running. Seen on the target server, at the first five-minute slot after the
 * handover.
 */
function dfmReadBackendMode()
{
  if (!is_file(DB_PATH)) {
    return 'php';
  }
  try {
    // A read-only handle, not the Database singleton. The singleton opens for
    // writing and sets the foreign-key and WAL pragmas, which a page render
    // that only reads one string does not need.
    $db = new SQLite3(DB_PATH, SQLITE3_OPEN_READONLY);
    $db->busyTimeout(5000);
    $stmt = $db->prepare('SELECT value FROM settings WHERE key = ?');
    if ($stmt === false) {
      $db->close();
      return null;
    }
    $stmt->bindValue(1, 'backend_mode', SQLITE3_TEXT);
    $result = $stmt->execute();
    if ($result === false) {
      $db->close();
      return null;
    }
    $row = $result->fetchArray(SQLITE3_ASSOC);
    $db->close();
    return dfmNormalizeBackendMode(is_array($row) ? $row['value'] : null);
  } catch (Throwable $e) {
    return null;
  }
}

function dfmBackendMode()
{
  $mode = dfmReadBackendMode();
  return $mode === null ? 'php' : $mode;
}

/**
 * Insert or replace one settings row. $key must be a fixed string or come
 * from settings.php's allowlist: it is bound, but the table is keyed on it.
 *
 * @param Database $db
 */
function dfmUpsertSetting($db, $key, $value)
{
  $db->query(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
      . ' ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [$key, $value, time()]
  );
}

/**
 * Store backend_mode, then heal the schedule-runner cron line. The plugin
 * never writes root's crontab, so schedules created in GraphQL mode do not
 * add the line PHP needs; without this, switching back to PHP, or PHP taking
 * over while the API is down, would leave nothing running them.
 *
 * @param Database $db
 */
function dfmWriteBackendMode($db, $mode)
{
  dfmUpsertSetting($db, 'backend_mode', dfmNormalizeBackendMode($mode));
  require_once PLUGIN_DIR . '/classes/CronManager.php';
  CronManager::ensureSchedulerCron($db);
}

/**
 * scripts/api-plugin.sh installs and removes the GraphQL backend. Both take
 * the Unraid API down for a restart, so web requests start it detached and
 * poll DFM_API_PLUGIN_STATE_FILE instead of waiting.
 */
define('DFM_API_PLUGIN_SCRIPT', PLUGIN_DIR . '/scripts/api-plugin.sh');
define('DFM_API_PLUGIN_STATE_FILE', '/var/run/' . PLUGIN_NAME . '.api-plugin.state');
// Written by the watchdog when it switches back to PHP. On /boot so the
// reason survives a reboot, and so a rollback that restarted the API cannot
// repeat until the user picks GraphQL again, which deletes it.
define('DFM_BACKEND_ROLLBACK_MARKER', CONFIG_DIR . '/backend-rollback.json');

/**
 * Start `api-plugin.sh install --activate`, `remove`, or `remove
 * --no-restart` (verb 'remove-no-restart'), detached. $runId tags the
 * state file so the settings page can find its own run.
 */
function dfmLaunchApiPlugin($verb, $runId = '')
{
  $args = [
    'install' => ['install', '--activate'],
    'remove' => ['remove'],
    'remove-no-restart' => ['remove', '--no-restart'],
  ][$verb] ?? null;
  if ($args === null) {
    return false;
  }
  if (preg_match('/^[0-9a-f]{1,32}$/', $runId)) {
    array_push($args, '--run', $runId);
  }
  $cmd = '/usr/bin/setsid /usr/bin/nohup /bin/bash ' . escapeshellarg(DFM_API_PLUGIN_SCRIPT);
  foreach ($args as $arg) {
    $cmd .= ' ' . escapeshellarg($arg);
  }
  exec($cmd . ' </dev/null >/dev/null 2>&1 &');
  return true;
}

/** Decode a small JSON file this plugin wrote, or null. */
function dfmReadJsonFile($path)
{
  $raw = @file_get_contents($path);
  if ($raw === false) {
    return null;
  }
  $data = json_decode($raw, true);
  return is_array($data) ? $data : null;
}

/**
 * Whether the Unraid API plugin that serves the GraphQL backend is usable.
 *
 * Returns 'ready', or a reason it is not: 'no-api', 'not-installed',
 * 'load-failed' or 'offline'. The settings page uses this to say
 * why the GraphQL option is unavailable instead of offering a switch that
 * would only fall back.
 *
 * The answer comes from asking the API, not from inspecting where it keeps
 * its files. `dockerFoldersInfo` is a field this project defines, so its
 * presence in the schema is the fact we actually care about, and it stays
 * true regardless of how upstream arranges its install directory or config.
 *
 * The probe sends no credentials, which is enough. A field that is absent
 * answers GRAPHQL_VALIDATION_FAILED, and a field that is present but
 * unauthorized answers UNAUTHENTICATED, so the two are distinguishable
 * without a session. What this cannot see is whether the plugin can read its
 * database, because that needs the browser's session cookie. The frontend
 * probe in `backends/graphql.ts` checks that and shows a notice when it fails.
 */
function dfmGraphqlPluginState()
{
  if (!file_exists(UNRAID_API_SOCKET)) {
    return 'no-api';
  }

  $ch = curl_init('http://localhost/graphql');
  curl_setopt_array($ch, [
    CURLOPT_UNIX_SOCKET_PATH => UNRAID_API_SOCKET,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode(['query' => 'query { dockerFoldersInfo { version } }']),
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    // A settings page must not hang on a wedged API.
    CURLOPT_CONNECTTIMEOUT => 1,
    CURLOPT_TIMEOUT => 2,
  ]);
  $body = curl_exec($ch);
  $failed = curl_errno($ch) !== 0;
  curl_close($ch);

  if ($failed || !is_string($body)) {
    return 'no-api';
  }
  return dfmClassifyGraphqlProbe($body, 'dfmGraphqlPluginInstalled');
}

/**
 * Read the probe's answer. A positive match on the field: an unauthenticated
 * answer names it in its error path. A missing field fails validation. Any
 * other answer, such as "Graphql is offline", means the API process runs but
 * its GraphQL service does not work, which the watchdog must tell apart from
 * a working backend.
 *
 * @param callable $installed Only called for a missing field.
 */
function dfmClassifyGraphqlProbe($body, callable $installed)
{
  if (preg_match('/"path":\["dockerFoldersInfo"\]|"dockerFoldersInfo":\{/', $body)) {
    return 'ready';
  }
  if (strpos($body, 'GRAPHQL_VALIDATION_FAILED') !== false) {
    return $installed() ? 'load-failed' : 'not-installed';
  }
  return 'offline';
}

/**
 * Whether the package is on disk, which separates "never installed" from
 * "installed but the API did not load it". The second case points at the API
 * log, where an invalid export shape is reported.
 *
 * This reads upstream's install layout, which is not a contract we own, so it
 * decides nothing on its own. It only picks which explanation to show once
 * the probe above has already established that the field is missing. A stale
 * answer here costs a wrong sentence, not a wrong switch.
 */
function dfmGraphqlPluginInstalled()
{
  return is_dir(UNRAID_API_DIR . '/node_modules/' . GRAPHQL_PLUGIN_NAME);
}

/**
 * Whether this PHP runner should fire due schedules this minute.
 *
 * Exactly one backend may. Both read `schedules.next_run_at`, so two runners
 * in the same minute start, stop or back up a container twice. The flock in
 * run-schedules.php cannot prevent that: it is a BSD advisory lock, which the
 * Unraid API's Node process has no way to take, so it only ever kept PHP from
 * racing itself.
 *
 * In GraphQL mode the plugin's runner owns schedules while its heartbeat file
 * is fresh. It touches that file every minute, and only when this function
 * exists, so the two halves can only ever be on together. If the API is
 * stopped, crashed, in safe mode or without the plugin, the file goes stale
 * within DFM_RUNNER_ALIVE_STALE_SECONDS and PHP takes the work back. That is
 * inside the runner's five-minute grace for a late run, so nothing is skipped.
 *
 * A file rather than a GraphQL probe: cron has no session, so every probe
 * logged two authentication errors in the API log, once a minute.
 */
define('DFM_RUNNER_ALIVE_FILE', '/var/run/' . PLUGIN_NAME . '.graphql-runner');
define('DFM_RUNNER_ALIVE_STALE_SECONDS', 150);

function dfmPhpOwnsSchedules()
{
  return !dfmPluginRunnerOwns('schedules');
}

/** The same arbitration for the image update check. See dfmPluginRunnerOwns(). */
function dfmPhpOwnsUpdateChecks()
{
  return !dfmPluginRunnerOwns('update-checks');
}

/**
 * Whether the plugin's runner owns one kind of background work this minute.
 *
 * The heartbeat file lists what that runner can do, one word per job, and is
 * rewritten every minute. PHP stands down for a job only when the file is
 * fresh and names it, so a plugin build that predates a job never makes PHP
 * stop doing that job.
 */
function dfmPluginRunnerOwns($job)
{
  clearstatcache(true, DFM_RUNNER_ALIVE_FILE);
  $alive = @filemtime(DFM_RUNNER_ALIVE_FILE);
  if ($alive === false || (time() - $alive) > DFM_RUNNER_ALIVE_STALE_SECONDS) {
    return false;
  }
  $jobs = preg_split('/\s+/', trim((string) @file_get_contents(DFM_RUNNER_ALIVE_FILE)));
  if (!in_array($job, $jobs, true)) {
    return false;
  }

  $mode = dfmReadBackendMode();
  // Unreadable, even after waiting, with the runner alive and able: stand
  // down. It reads the mode itself and acts only in GraphQL mode, so the worst
  // case is one missed minute instead of the same job run twice.
  return $mode === null || $mode === 'graphql';
}

// JSON response helper
function jsonResponse($data, $statusCode = 200)
{
  http_response_code($statusCode);
  header('Content-Type: application/json');
  echo json_encode($data);
  exit();
}

// Error response helper
function errorResponse($message, $statusCode = 500)
{
  jsonResponse(
    [
      'error' => true,
      'message' => $message,
    ],
    $statusCode,
  );
}
