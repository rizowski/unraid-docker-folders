<?php

require_once dirname(__DIR__) . '/include/config.php';
require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/DockerClient.php';

class BackupManager
{
  // What happens to the container while its files are archived.
  const QUIESCE_NONE = 'none';
  const QUIESCE_PAUSE = 'pause';
  const QUIESCE_STOP = 'stop';

  // Docker's own default stop timeout is 10 seconds, which is not enough for a
  // database to checkpoint and close. The SIGKILL that follows would leave the
  // files in the same crash state that stopping was meant to avoid.
  const QUIESCE_STOP_TIMEOUT = 30;

  // The first 16 bytes of every SQLite database file.
  const SQLITE_MAGIC = "SQLite format 3\0";

  // The timestamp generateArchiveName() writes, date('Y-m-d_His'). Every rule
  // that decides whether a file is one of our archives matches this shape.
  const ARCHIVE_STAMP_PATTERN = '\d{4}-\d{2}-\d{2}_\d{6}';

  // Scopes for archivesFor().
  const ARCHIVES_EXACT = 'exact';
  const ARCHIVES_STACK = 'stack';

  // Containers this process paused or stopped and has not restored yet.
  private static $pendingRestore = [];
  private static $shutdownRegistered = false;

  private $db;
  private $dockerClient;

  public function __construct()
  {
    $this->db = Database::getInstance();
    $this->dockerClient = new DockerClient();
  }

  public function backupContainer(
    $containerName,
    $patterns,
    $destination = null,
    $retention = null,
    $quiesce = self::QUIESCE_NONE
  ) {
    $destination = $this->resolveDestination($destination);
    $retention = $this->resolveRetention($retention);
    $quiesce = self::quiesceModeFor($quiesce);

    if (!$this->ensureDirectory($destination)) {
      return ['success' => false, 'message' => "Cannot create backup directory: {$destination}"];
    }

    // The container itself, not just its paths: withQuiesce() needs the id.
    $container = $this->findContainer($containerName);
    if (!$container) {
      return ['success' => false, 'message' => "Container '{$containerName}' not found"];
    }

    $hostPaths = $this->resolveHostPathsForContainer($container['id'], $patterns);
    if (empty($hostPaths)) {
      return ['success' => false, 'message' => "No matching paths found for container '{$containerName}'"];
    }

    $archiveName = $this->generateArchiveName($containerName);
    $archivePath = rtrim($destination, '/') . '/' . $archiveName;

    $job = $this->runArchiveJob($container['id'], $quiesce, $archivePath, $hostPaths);

    if (!$job['success']) {
      $message = $job['failure'] === 'quiesce'
        ? $job['detail']
        : "Failed to create archive: {$archiveName}{$job['detail']}";
      if ($job['restore_error'] !== '') {
        $message .= '. ' . $job['restore_error'];
      }
      return ['success' => false, 'message' => $message];
    }

    $size = file_exists($archivePath) ? filesize($archivePath) : 0;
    $pruned = $this->pruneOldBackups($destination, $containerName, $retention);
    $message = "Backup created: {$archiveName}" . $job['note']
      . ($pruned ? ", pruned {$pruned} old backup(s)" : '');

    // A container left frozen is worse than a missing backup, so this reports
    // as a failure even though the archive is on disk. The runner turns a
    // failure into a warning notification.
    if ($job['restore_error'] !== '') {
      return [
        'success' => false,
        'message' => $message . '. ' . $job['restore_error'],
        'backup_file' => $archivePath,
        'backup_size' => $size,
      ];
    }

    return [
      'success' => true,
      'message' => $message,
      'backup_file' => $archivePath,
      'backup_size' => $size,
    ];
  }

  public function backupStack(
    $projectName,
    $serviceConfigs,
    $destination = null,
    $retention = null,
    $quiesce = self::QUIESCE_NONE
  ) {
    $destination = $this->resolveDestination($destination);
    $retention = $this->resolveRetention($retention);
    $quiesce = self::quiesceModeFor($quiesce);

    if (!$this->ensureDirectory($destination)) {
      return ['success' => false, 'message' => "Cannot create backup directory: {$destination}"];
    }

    $containers = $this->dockerClient->listContainers(true);
    $stackContainers = [];
    foreach ($containers as $c) {
      $project = $c['labels']['com.docker.compose.project'] ?? null;
      if ($project === $projectName) {
        $service = $c['labels']['com.docker.compose.service'] ?? $c['name'];
        $stackContainers[$service] = $c;
      }
    }

    if (empty($stackContainers)) {
      return ['success' => false, 'message' => "No containers found for stack '{$projectName}'"];
    }

    $results = [];
    $allSuccess = true;
    $archived = 0;

    // Every path that archives nothing is a failure, the same as in
    // backupContainer(). Before, a malformed entry was skipped in silence, so
    // a config where no entry was valid reported success.
    foreach ((array) $serviceConfigs as $config) {
      $service = $config['service'] ?? null;
      $patterns = $config['patterns'] ?? [];

      if (!$service || empty($patterns)) {
        $results[] = 'Skipped a service entry with no service name or no paths';
        $allSuccess = false;
        continue;
      }

      if (!isset($stackContainers[$service])) {
        $results[] = "Service '{$service}' not found in stack";
        $allSuccess = false;
        continue;
      }

      $container = $stackContainers[$service];
      $hostPaths = $this->resolveHostPathsForContainer($container['id'], $patterns);

      if (empty($hostPaths)) {
        $results[] = "No matching paths for service '{$service}'";
        $allSuccess = false;
        continue;
      }

      $prefix = "{$projectName}.{$service}";
      $archiveName = $this->generateArchiveName($prefix);
      $archivePath = rtrim($destination, '/') . '/' . $archiveName;

      // Quiet each service around its own archive, not the whole stack around
      // all of them. One service at a time is far less downtime.
      $job = $this->runArchiveJob($container['id'], $quiesce, $archivePath, $hostPaths);

      if (!$job['success']) {
        $results[] = $job['failure'] === 'quiesce'
          ? "Service '{$service}': " . $job['detail']
          : "Failed to create archive for service '{$service}'{$job['detail']}";
        if ($job['restore_error'] !== '') {
          $results[] = "Service '{$service}': " . $job['restore_error'];
        }
        $allSuccess = false;
        continue;
      }

      if ($job['restore_error'] !== '') {
        $results[] = "Service '{$service}': " . $job['restore_error'];
        $allSuccess = false;
      }

      $this->pruneOldBackups($destination, $prefix, $retention);
      $results[] = "Backed up service '{$service}': {$archiveName}" . $job['note'];
      $archived++;
    }

    if ($archived === 0) {
      $allSuccess = false;
      if (empty($results)) {
        $results[] = "No services configured for stack '{$projectName}'";
      }
    }

    $size = 0;
    $lastArchive = '';
    $safeProject = sanitizeArchivePrefix($projectName);
    $files = $safeProject === null
      ? []
      : glob(rtrim($destination, '/') . "/{$safeProject}.*.tar.gz");
    if ($files) {
      $lastArchive = end($files);
      $size = filesize($lastArchive);
    }

    return [
      'success' => $allSuccess,
      'message' => implode('; ', $results),
      'backup_file' => $lastArchive,
      'backup_size' => $size,
    ];
  }

  public function listBackups($targetType, $targetId)
  {
    $destination = $this->resolveDestination(null);
    if (!is_dir($destination)) {
      return [];
    }

    // $targetId reaches here straight from the request. Unsanitized it would be
    // injected into a glob pattern, where both ../ and the glob metacharacters
    // turn this listing into a directory oracle over the whole filesystem.
    // Must match generateArchiveName's sanitizer, or this stops finding the
    // archives that were actually written.
    $prefix = sanitizeArchivePrefix($targetId);
    if ($prefix === null) {
      return [];
    }

    $pattern = rtrim($destination, '/') . '/' . $prefix . '.*.tar.gz';
    $files = glob($pattern);

    if (!$files) {
      return [];
    }

    usort($files, function ($a, $b) {
      return filemtime($b) - filemtime($a);
    });

    $backups = [];
    foreach ($files as $file) {
      $backups[] = [
        'path' => $file,
        'filename' => basename($file),
        'size' => filesize($file),
        'created_at' => filemtime($file),
      ];
    }

    return $backups;
  }

  public function deleteBackup($filePath)
  {
    $destination = $this->resolveDestination(null);
    $realDest = realpath($destination);
    $realFile = realpath($filePath);

    if (!$realFile || !$realDest) {
      return false;
    }

    // Only an archive this plugin wrote, directly in the destination.
    // Containment alone is not enough. The destination can be an allowed root
    // itself, such as /mnt, or a broad one such as /mnt/user, and then "inside
    // the destination" means every file on the array.
    if (dirname($realFile) !== $realDest || !self::isArchiveName(basename($realFile))) {
      return false;
    }

    if (!is_file($realFile)) {
      return false;
    }

    return unlink($realFile);
  }

  /**
   * Is $basename shaped like a file generateArchiveName() writes?
   *
   * @param string $basename A file name with no directory part
   * @return bool
   */
  public static function isArchiveName($basename)
  {
    if (!is_string($basename)) {
      return false;
    }

    return preg_match(
      '/^[A-Za-z0-9][A-Za-z0-9._-]*\.' . self::ARCHIVE_STAMP_PATTERN . '\.tar\.gz$/',
      $basename
    ) === 1;
  }

  private function resolveDestination($override)
  {
    $dest = $override;
    if (!$dest) {
      $row = $this->db->fetchOne("SELECT value FROM settings WHERE key = 'backup_destination'");
      $dest = $row ? $row['value'] : '/mnt/user/backups/docker-folders';
    }

    // Block writing outside safe base paths. Normalize first: a raw prefix test
    // accepts "/mnt/../etc", which collapses to somewhere else entirely.
    $normalized = normalizePath($dest);
    if ($normalized === null || !pathIsWithinAny($normalized, BACKUP_ALLOWED_ROOTS)) {
      throw new InvalidArgumentException("Backup destination must be under /mnt/ or /boot/config/plugins/");
    }

    return $normalized;
  }

  private function resolveRetention($override)
  {
    if ($override !== null) {
      return max(1, (int) $override);
    }

    $row = $this->db->fetchOne("SELECT value FROM settings WHERE key = 'default_retention_count'");
    return $row ? max(1, (int) $row['value']) : 7;
  }

  private function ensureDirectory($path)
  {
    if (is_dir($path)) {
      return true;
    }
    return mkdir($path, 0755, true);
  }

  public function resolveHostPaths($containerName, $patterns)
  {
    $container = $this->findContainer($containerName);
    return $container ? $this->resolveHostPathsForContainer($container['id'], $patterns) : [];
  }

  private function findContainer($containerName)
  {
    foreach ($this->dockerClient->listContainers(true) as $c) {
      if ($c['name'] === $containerName) {
        return $c;
      }
    }
    return null;
  }

  /**
   * Map a path inside a container onto its path on the host.
   *
   * Picks the longest matching mount Destination, so a nested mount wins over
   * the parent that also covers the path. Returns null when no mount covers
   * it, or when the part below the mount climbs back out with "..".
   *
   * Pure and static so both the backup runner and api/paths.php can use it,
   * and so the suite can test it without a Docker socket.
   *
   * @param string $containerPath A path as the container sees it
   * @param array $mounts Docker mount entries, with Source and Destination
   * @return array|null
   */
  public static function mapContainerPath($containerPath, array $mounts)
  {
    $best = null;
    $bestLength = -1;

    foreach ($mounts as $mount) {
      $dest = rtrim(isset($mount['Destination']) ? $mount['Destination'] : '', '/');
      $src = rtrim(isset($mount['Source']) ? $mount['Source'] : '', '/');

      if ($dest === '' || $src === '' || strlen($dest) <= $bestLength) {
        continue;
      }

      if ($containerPath === $dest || $containerPath === $dest . '/') {
        $relative = '';
      } elseif (strpos($containerPath, $dest . '/') === 0) {
        $relative = substr($containerPath, strlen($dest) + 1);
      } else {
        continue;
      }

      // The relative part is user supplied and would otherwise walk out of the
      // mount source. It is never normalized on its own, only rejected.
      if ($relative !== '' && in_array('..', explode('/', $relative), true)) {
        continue;
      }

      $bestLength = strlen($dest);
      $best = [
        'mount_destination' => $dest,
        'mount_source' => $src,
        'relative' => $relative,
        'host_path' => $relative === '' ? $src : $src . '/' . $relative,
      ];
    }

    return $best;
  }

  /**
   * True when the file starts with the SQLite header.
   */
  public static function isSqliteFile($path)
  {
    if (!is_file($path)) {
      return false;
    }

    $handle = @fopen($path, 'rb');
    if (!$handle) {
      return false;
    }

    $header = fread($handle, 16);
    fclose($handle);

    return $header === self::SQLITE_MAGIC;
  }

  /**
   * The write-ahead log and journal files that sit beside a database file.
   */
  public static function sidecarsFor($path)
  {
    $found = [];
    foreach (['-wal', '-shm', '-journal'] as $suffix) {
      if (is_file($path . $suffix)) {
        $found[] = $path . $suffix;
      }
    }
    return $found;
  }

  /**
   * Add the sidecar files of every database file in the list.
   *
   * A directory is archived whole, so tar already walks its sidecars. A single
   * file is not: a pattern such as /config/*.db matches app.db and leaves
   * app.db-wal behind. That copy is missing every committed transaction still
   * in the write-ahead log, which is the usual way a restored database turns
   * out broken.
   */
  private static function withSidecars(array $paths)
  {
    $expanded = [];

    foreach ($paths as $path) {
      $expanded[] = $path;

      if (is_dir($path) || !self::isSqliteFile($path)) {
        continue;
      }

      foreach (self::sidecarsFor($path) as $sidecar) {
        $expanded[] = $sidecar;
      }
    }

    return array_values(array_unique($expanded));
  }

  /**
   * Coerce a stored quiesce value to one of the three known modes.
   */
  public static function quiesceModeFor($value)
  {
    $mode = is_string($value) ? strtolower(trim($value)) : '';

    return in_array($mode, [self::QUIESCE_PAUSE, self::QUIESCE_STOP], true)
      ? $mode
      : self::QUIESCE_NONE;
  }

  private function resolveHostPathsForContainer($containerId, $patterns)
  {
    $detail = $this->dockerClient->inspectContainer($containerId);
    if (!$detail) {
      return [];
    }

    $mounts = $detail['mounts'] ?? [];
    $hostPaths = [];

    foreach ($patterns as $pattern) {
      $mapped = self::mapContainerPath($pattern, $mounts);
      if ($mapped === null) {
        continue;
      }

      $src = $mapped['mount_source'];
      $hostPath = $mapped['host_path'];

      // The whole mount. tar walks it, so there is nothing more to resolve.
      if ($mapped['relative'] === '') {
        $hostPaths[] = $src;
        continue;
      }

      if (strpos($mapped['relative'], '*') !== false || strpos($mapped['relative'], '?') !== false) {
        $globbed = glob($hostPath);
        if ($globbed) {
          foreach ($globbed as $match) {
            if (pathIsWithin($match, $src)) {
              $hostPaths[] = $match;
            }
          }
        }
        continue;
      }

      if (pathIsWithin($hostPath, $src) && file_exists($hostPath)) {
        $hostPaths[] = $hostPath;
      }
    }

    return self::withSidecars(array_unique($hostPaths));
  }

  /**
   * Write one archive with the container quieted, and say what happened.
   *
   * 'success' means the archive reached disk. On a failure, 'failure' names
   * the step that failed, either 'quiesce' or 'archive', and 'detail' holds
   * the words that step produced. The caller words the message itself,
   * because a single container and one service of a stack name themselves
   * differently. 'note' and 'restore_error' come straight from withQuiesce().
   */
  private function runArchiveJob($containerId, $quiesce, $archivePath, $hostPaths)
  {
    $run = $this->withQuiesce($containerId, $quiesce, function () use ($archivePath, $hostPaths) {
      return $this->createArchive($archivePath, $hostPaths);
    });

    if (!$run['ok']) {
      return ['success' => false, 'failure' => 'quiesce', 'detail' => $run['message'],
        'note' => '', 'restore_error' => ''];
    }

    // The archive can fail and the restore can fail in the same run. Both are
    // reported, because the second one means the container is still stopped
    // or paused.
    $archive = $run['result'];
    if (!$archive['success']) {
      return ['success' => false, 'failure' => 'archive',
        'detail' => $archive['output'] !== '' ? ': ' . $archive['output'] : '',
        'note' => '', 'restore_error' => $run['restore_error']];
    }

    return ['success' => true, 'failure' => '', 'detail' => '',
      'note' => $run['note'], 'restore_error' => $run['restore_error']];
  }

  /**
   * Run $work with the container paused or stopped, then put it back.
   *
   * Returns ['ok' => false, 'message' => ...] when the container could not be
   * quieted, and $work never runs. Otherwise 'result' holds what $work
   * returned, 'note' is text for the success message, and 'restore_error' is
   * non-empty when the container could not be started or resumed afterward.
   */
  private function withQuiesce($containerId, $mode, callable $work)
  {
    $quiet = ['ok' => true, 'note' => '', 'restore_error' => '', 'result' => null];

    if ($mode !== self::QUIESCE_PAUSE && $mode !== self::QUIESCE_STOP) {
      $quiet['result'] = $work();
      return $quiet;
    }

    $state = $this->containerRunState($containerId);

    // A stopped container is already as quiet as it gets, and starting it
    // afterward would be a state change nobody asked for. A container someone
    // else paused is left paused for the same reason.
    if ($state === 'exited' || $state === 'paused') {
      $quiet['result'] = $work();
      return $quiet;
    }

    // Inspect failed, so the state is unknown. Running the archive anyway is
    // the silent downgrade this mode exists to prevent.
    if ($state !== 'running') {
      return self::quiesceFailure('Could not read the container state before the backup');
    }

    $quieted = $mode === self::QUIESCE_PAUSE
      ? $this->dockerClient->pauseContainer($containerId)
      : $this->dockerClient->stopContainer($containerId, self::QUIESCE_STOP_TIMEOUT);

    // Never fall back to an unquiet backup. The user picked this mode to
    // protect a database, and a silent downgrade hands them an archive they
    // believe is safe.
    if (!$quieted) {
      return self::quiesceFailure("Could not {$mode} the container before the backup");
    }

    self::markPending($containerId, $mode);

    try {
      $quiet['result'] = $work();
    } finally {
      $restored = $this->restoreContainer($containerId, $mode);
    }

    if (!$restored) {
      $verb = $mode === self::QUIESCE_PAUSE ? 'resumed' : 'started';
      $quiet['restore_error'] = "The container could not be {$verb} again after the backup";
      return $quiet;
    }

    $quiet['note'] = $mode === self::QUIESCE_PAUSE
      ? ' (container paused during backup)'
      : ' (container stopped during backup)';

    return $quiet;
  }

  /** The shape withQuiesce() returns when the work never ran. */
  private static function quiesceFailure($message)
  {
    return [
      'ok' => false,
      'note' => '',
      'restore_error' => '',
      'result' => null,
      'message' => $message,
    ];
  }

  private function containerRunState($containerId)
  {
    $raw = $this->dockerClient->inspectContainerRaw($containerId);
    if (!$raw || empty($raw['State'])) {
      return 'unknown';
    }
    if (!empty($raw['State']['Paused'])) {
      return 'paused';
    }

    return !empty($raw['State']['Running']) ? 'running' : 'exited';
  }

  private function restoreContainer($containerId, $mode)
  {
    // startContainer() already unpauses a paused container, so both modes are
    // safe to call whatever state the container ended up in.
    $ok = $mode === self::QUIESCE_PAUSE
      ? $this->dockerClient->unpauseContainer($containerId)
      : $this->dockerClient->startContainer($containerId);

    if ($ok) {
      unset(self::$pendingRestore[$containerId]);
    }

    return $ok;
  }

  private static function markPending($containerId, $mode)
  {
    self::$pendingRestore[$containerId] = $mode;

    if (self::$shutdownRegistered) {
      return;
    }
    self::$shutdownRegistered = true;

    // A PHP fatal between the pause and the unpause would otherwise leave the
    // container frozen until somebody noticed. This does not cover SIGKILL or
    // a power cut. A container paused that way stays paused until the next
    // reboot, and the reboot clears it.
    register_shutdown_function(function () {
      if (empty(self::$pendingRestore)) {
        return;
      }

      $docker = new DockerClient();
      foreach (self::$pendingRestore as $id => $mode) {
        if ($mode === self::QUIESCE_PAUSE) {
          $docker->unpauseContainer($id);
        } else {
          $docker->startContainer($id);
        }
        error_log("BackupManager: restored container {$id} after an unclean exit");
      }

      self::$pendingRestore = [];
    });
  }

  private function createArchive($archivePath, $hostPaths)
  {
    $pathArgs = [];
    foreach ($hostPaths as $p) {
      $pathArgs[] = escapeshellarg($p);
    }

    $cmd = 'tar czf ' . escapeshellarg($archivePath) . ' ' . implode(' ', $pathArgs) . ' 2>&1';
    exec($cmd, $output, $exitCode);

    // A failed archive is reported as a failure, so it must not stay on disk.
    // It would be the newest file for this target, and retention keeps the
    // newest, so each failed run would push out one good backup. tar exits 1
    // on "file changed as we read it", which already counts as a failure here.
    if ($exitCode !== 0 && is_file($archivePath)) {
      @unlink($archivePath);
    }

    // tar's own words matter. "file changed as we read it" is what a backup of
    // a running container looks like, and the caller used to report only
    // "Failed to create archive".
    return [
      'success' => $exitCode === 0,
      'output' => implode('; ', array_slice($output, -3)),
    ];
  }

  private function pruneOldBackups($destination, $prefix, $retention)
  {
    // Exactly the archives this prefix wrote. A glob of "<prefix>.*.tar.gz"
    // also matched other targets: a container named "blog" pruned the
    // "blog.web.<stamp>" archives of a stack named "blog".
    $files = self::archivesFor($destination, $prefix, self::ARCHIVES_EXACT);

    if (count($files) <= $retention) {
      return 0;
    }

    $deleted = 0;
    foreach (array_slice($files, $retention) as $file) {
      if (unlink($file)) {
        $deleted++;
      }
    }

    return $deleted;
  }

  /**
   * The archives in $dir that belong to one target, newest first.
   *
   * ARCHIVES_EXACT matches "<prefix>.<stamp>.tar.gz", which is one container,
   * or one stack service when $prefix is "project.service". ARCHIVES_STACK
   * matches "<prefix>.<service>.<stamp>.tar.gz", which is every service of the
   * stack named $prefix.
   *
   * The directory is read with scandir(), not glob(), so a destination that
   * contains a glob metacharacter cannot match a sibling directory.
   *
   * One collision remains that no name rule can separate. A container named
   * "blog.web" and service "web" of a stack named "blog" write the same name.
   *
   * @param string $dir The backup destination
   * @param string $prefix A container name, "project.service", or a project
   * @param string $scope ARCHIVES_EXACT or ARCHIVES_STACK
   * @return string[] Full paths, newest first
   */
  public static function archivesFor($dir, $prefix, $scope = self::ARCHIVES_EXACT)
  {
    // Must match generateArchiveName's sanitizer, or this stops finding the
    // archives that were actually written.
    $safePrefix = sanitizeArchivePrefix($prefix);
    if ($safePrefix === null || !is_dir($dir)) {
      return [];
    }

    $service = $scope === self::ARCHIVES_STACK ? '\.[A-Za-z0-9][A-Za-z0-9._-]*' : '';
    $regex = '/^' . preg_quote($safePrefix, '/') . $service . '\.'
      . self::ARCHIVE_STAMP_PATTERN . '\.tar\.gz$/';

    $dir = rtrim($dir, '/');
    $files = [];
    foreach (scandir($dir) ?: [] as $name) {
      if (preg_match($regex, $name) !== 1) {
        continue;
      }
      $path = $dir . '/' . $name;
      if (is_file($path) && !is_link($path)) {
        $files[] = $path;
      }
    }

    // Newest first. The name breaks a tie, since its stamp sorts in time order.
    usort($files, function ($a, $b) {
      return (filemtime($b) - filemtime($a)) ?: strcmp(basename($b), basename($a));
    });

    return $files;
  }

  private function generateArchiveName($prefix)
  {
    // $prefix is a container name, or "project.service". Coerce rather than
    // reject: backupStack() loops over services, so throwing here would abort
    // the backups for every remaining service in the stack.
    $safePrefix = sanitizeArchivePrefix($prefix);
    if ($safePrefix === null) {
      $safePrefix = 'backup';
    }

    return $safePrefix . '.' . date('Y-m-d_His') . '.tar.gz';
  }
}
