<?php
/**
 * Unraid Docker Folders - Path Suggestion API
 *
 * Lists directories so the backup form can suggest paths while the user types,
 * the way Unraid's own volume field does.
 *
 * Read only, GET only, and bounded two ways. A host listing stays inside
 * BACKUP_ALLOWED_ROOTS. A container listing stays inside the named container's
 * own mount sources. Without those bounds this endpoint is a directory oracle
 * over the whole filesystem.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';
require_once dirname(__DIR__) . '/classes/BackupManager.php';

header('Content-Type: application/json');

requireAuth();

// Enough to pick from, few enough that one keystroke never stats a whole share.
define('PATH_SUGGEST_LIMIT', 50);

// How many files to read headers from when answering "is there a database in
// this folder". A bounded scan, because an appdata folder can hold thousands.
define('PATH_SQLITE_SCAN_LIMIT', 200);

$method = $_SERVER['REQUEST_METHOD'];

try {
  switch ($method) {
    case 'GET':
      handleGet();
      break;

    case 'OPTIONS':
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Paths API error: ' . $e->getMessage());
  errorResponse('Failed to list paths', 500);
}

function handleGet()
{
  $scope = isset($_GET['scope']) ? $_GET['scope'] : 'host';
  $path = isset($_GET['path']) ? (string) $_GET['path'] : '';

  if ($scope === 'container') {
    jsonResponse(suggestContainerPaths(
      isset($_GET['container']) ? (string) $_GET['container'] : '',
      $path,
      isset($_GET['project']) ? (string) $_GET['project'] : ''
    ));
    return;
  }

  jsonResponse(suggestHostPaths($path));
}

/**
 * Suggest host paths under the roots a backup is allowed to write to.
 */
function suggestHostPaths($typed)
{
  $typed = trim($typed);

  // Nothing useful typed yet, or the user is still spelling out a root. Offer
  // the roots themselves rather than refusing, because "/mn" has a parent of
  // "/", and "/" is deliberately never inside any allowed root.
  $roots = [];
  foreach (BACKUP_ALLOWED_ROOTS as $root) {
    if ($typed === '' || strncasecmp($root, $typed, strlen($typed)) === 0) {
      $roots[] = ['name' => $root, 'path' => $root];
    }
  }
  if (!empty($roots)) {
    return ['base' => '', 'entries' => $roots, 'has_sqlite' => false];
  }

  list($parent, $prefix) = splitTypedPath($typed);

  $parent = normalizePath($parent);
  if ($parent === null || !pathIsWithinAny($parent, BACKUP_ALLOWED_ROOTS)) {
    return ['base' => '', 'entries' => [], 'has_sqlite' => false];
  }

  $names = listDirectoryNames($parent, $prefix);
  $entries = [];
  foreach ($names as $name) {
    $entries[] = ['name' => $name, 'path' => rtrim($parent, '/') . '/' . $name];
  }

  // No database scan here. This listing feeds the destination field, which
  // has no warning to show, and the scan reads up to 200 file headers.
  return [
    'base' => $parent,
    'entries' => $entries,
    'has_sqlite' => false,
  ];
}

/**
 * Suggest paths as the named container sees them.
 *
 * The user types a container path, so every suggestion is translated back into
 * container terms even though the listing happens on the host.
 */
function suggestContainerPaths($containerName, $typed, $project = '')
{
  $typed = trim($typed);
  $empty = ['base' => '', 'entries' => [], 'has_sqlite' => false];

  if ($containerName === '') {
    return $empty;
  }

  $mounts = containerMounts($containerName, $project);
  if (empty($mounts)) {
    return $empty;
  }

  list($parent, $prefix) = splitTypedPath($typed);
  $mapped = $parent === '' ? null : BackupManager::mapContainerPath($parent, $mounts);

  // Still above every mount, so the mounts themselves are the suggestions.
  if ($mapped === null) {
    $entries = [];
    foreach ($mounts as $mount) {
      $dest = rtrim(isset($mount['Destination']) ? $mount['Destination'] : '', '/');
      if ($dest === '' || ($typed !== '' && strncasecmp($dest, $typed, strlen($typed)) !== 0)) {
        continue;
      }
      $entries[] = ['name' => $dest, 'path' => $dest];
    }
    return ['base' => '', 'entries' => $entries, 'has_sqlite' => false];
  }

  $hostParent = $mapped['host_path'];
  if (!pathIsWithin($hostParent, $mapped['mount_source'])) {
    return $empty;
  }

  $names = listDirectoryNames($hostParent, $prefix, $mapped['mount_source']);
  $entries = [];
  foreach ($names as $name) {
    $entries[] = [
      'name' => $name,
      'path' => rtrim($parent, '/') . '/' . $name,
    ];
  }

  return [
    'base' => $parent,
    'entries' => $entries,
    'has_sqlite' => directoryHasSqlite($hostParent),
  ];
}

/**
 * Find a container by its own name, or by compose project and service.
 *
 * A stack schedule stores service names, and a compose container is named
 * "<project>-<service>-1", so the name never matches. backupStack() resolves
 * the same pair through the same two labels.
 */
function containerMounts($containerName, $project = '')
{
  $docker = new DockerClient();

  // A plain name goes straight to the socket. listContainers() reads every
  // user template off the USB flash boot device to build its autostart map,
  // and this endpoint answers one keystroke.
  if ($project === '') {
    // The name reaches the Docker API inside a URL path, so it passes the same
    // check api/containers.php applies to a container name. A name that fails
    // is refused rather than sent down the slow path below, which would make
    // the check pointless. Docker also resolves an id prefix here, which the
    // list scan never did.
    if (safePathComponent($containerName) === null) {
      return [];
    }

    $detail = $docker->inspectContainer($containerName);
    return $detail && isset($detail['mounts']) ? $detail['mounts'] : [];
  }

  foreach ($docker->listContainers(true) as $container) {
    $labels = isset($container['labels']) ? $container['labels'] : [];
    $service = isset($labels['com.docker.compose.service']) ? $labels['com.docker.compose.service'] : null;
    $inProject = isset($labels['com.docker.compose.project'])
      && $labels['com.docker.compose.project'] === $project;

    $matches = $container['name'] === $containerName
      || ($service === $containerName && $inProject);

    if (!$matches) {
      continue;
    }

    $detail = $docker->inspectContainer($container['id']);
    return $detail && isset($detail['mounts']) ? $detail['mounts'] : [];
  }

  return [];
}

/**
 * Split what the user typed into a directory to list and a name prefix.
 *
 * A trailing slash means the user finished a directory name and wants its
 * contents, so the prefix is empty.
 */
function splitTypedPath($typed)
{
  if ($typed === '' || substr($typed, -1) === '/') {
    return [rtrim($typed, '/') === '' ? $typed : rtrim($typed, '/'), ''];
  }

  $slash = strrpos($typed, '/');
  if ($slash === false) {
    return ['', $typed];
  }

  $parent = $slash === 0 ? '/' : substr($typed, 0, $slash);

  return [$parent, substr($typed, $slash + 1)];
}

/**
 * List the subdirectory names of $parent that start with $prefix.
 *
 * $containBase, when given, is re-tested against each entry's real path. A
 * symbolic link inside a mount can otherwise point straight out of it.
 */
function listDirectoryNames($parent, $prefix, $containBase = null)
{
  if (!is_dir($parent)) {
    return [];
  }

  $all = @scandir($parent);
  if ($all === false) {
    return [];
  }

  // /mnt/remotes holds network mounts. One is_dir() per entry stats the remote
  // server and can hang the whole request, so those entries are returned as
  // names without the test.
  $remote = pathIsWithin($parent, '/mnt/remotes');

  $names = [];
  foreach ($all as $name) {
    if ($name === '.' || $name === '..') {
      continue;
    }
    if ($prefix !== '' && strncasecmp($name, $prefix, strlen($prefix)) !== 0) {
      continue;
    }

    if (!$remote) {
      $full = rtrim($parent, '/') . '/' . $name;
      if (!is_dir($full)) {
        continue;
      }
      $real = realpath($full);
      if ($containBase !== null && (!$real || !pathIsWithin($real, $containBase))) {
        continue;
      }
    }

    $names[] = $name;
    if (count($names) >= PATH_SUGGEST_LIMIT) {
      break;
    }
  }

  sort($names);

  return $names;
}

/**
 * True when a file directly inside this directory is a SQLite database.
 *
 * The form uses it to warn that a backup of this folder needs the container
 * paused or stopped.
 */
function directoryHasSqlite($directory)
{
  if (!is_dir($directory) || pathIsWithin($directory, '/mnt/remotes')) {
    return false;
  }

  $all = @scandir($directory);
  if ($all === false) {
    return false;
  }

  $scanned = 0;
  foreach ($all as $name) {
    if ($name === '.' || $name === '..') {
      continue;
    }
    if ($scanned++ >= PATH_SQLITE_SCAN_LIMIT) {
      break;
    }
    if (BackupManager::isSqliteFile(rtrim($directory, '/') . '/' . $name)) {
      return true;
    }
  }

  return false;
}
