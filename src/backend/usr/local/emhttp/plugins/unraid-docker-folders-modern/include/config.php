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

// Database
define('DB_PATH', CONFIG_DIR . '/data.db');

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
define('NCHAN_PUB_URL', 'http://localhost:4433/pub/docker-modern');
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
date_default_timezone_set('UTC');

require_once __DIR__ . '/paths.php';
require_once dirname(__DIR__) . '/classes/ReleaseNotes.php';

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

  // Collect unique images
  $uniqueImages = [];
  foreach ($containers as $container) {
    $image = $container['image'] ?? '';
    $imageId = $container['imageId'] ?? '';
    if ($image && !isset($uniqueImages[$image])) {
      $uniqueImages[$image] = $imageId;
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

    // Wrap each image check in try/catch so one failure doesn't kill the loop
    try {
      $check = $dockerClient->checkImageUpdate($imageName, $imageId);
      $checked++;

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
      $checked++;
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
  ];
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
      'etag' => null,
      'status' => in_array($status, ['ok', 'not_found'], true) ? $status : 'error',
      'fetched_at' => $now,
    ];

    $db->query(
      'INSERT OR REPLACE INTO release_notes (repo, tag, name, published_at, url, summary, etag, status, fetched_at)
       VALUES (:repo, :tag, :name, :published_at, :url, :summary, :etag, :status, :fetched_at)',
      [
        ':repo' => $row['repo'],
        ':tag' => $row['tag'],
        ':name' => $row['name'],
        ':published_at' => $row['published_at'],
        ':url' => $row['url'],
        ':summary' => $row['summary'],
        ':etag' => $row['etag'],
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
