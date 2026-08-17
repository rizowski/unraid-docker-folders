<?php

require_once dirname(__DIR__) . '/include/config.php';
require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/DockerClient.php';

class BackupManager
{
  private $db;
  private $dockerClient;

  public function __construct()
  {
    $this->db = Database::getInstance();
    $this->dockerClient = new DockerClient();
  }

  public function backupContainer($containerName, $patterns, $destination = null, $retention = null)
  {
    $destination = $this->resolveDestination($destination);
    $retention = $this->resolveRetention($retention);

    if (!$this->ensureDirectory($destination)) {
      return ['success' => false, 'message' => "Cannot create backup directory: {$destination}"];
    }

    $hostPaths = $this->resolveHostPaths($containerName, $patterns);
    if (empty($hostPaths)) {
      return ['success' => false, 'message' => "No matching paths found for container '{$containerName}'"];
    }

    $archiveName = $this->generateArchiveName($containerName);
    $archivePath = rtrim($destination, '/') . '/' . $archiveName;

    if (!$this->createArchive($archivePath, $hostPaths)) {
      return ['success' => false, 'message' => "Failed to create archive: {$archivePath}"];
    }

    $size = file_exists($archivePath) ? filesize($archivePath) : 0;
    $pruned = $this->pruneOldBackups($destination, $containerName, $retention);

    return [
      'success' => true,
      'message' => "Backup created: {$archiveName}" . ($pruned ? ", pruned {$pruned} old backup(s)" : ''),
      'backup_file' => $archivePath,
      'backup_size' => $size,
    ];
  }

  public function backupStack($projectName, $serviceConfigs, $destination = null, $retention = null)
  {
    $destination = $this->resolveDestination($destination);
    $retention = $this->resolveRetention($retention);

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

    foreach ($serviceConfigs as $config) {
      $service = $config['service'] ?? null;
      $patterns = $config['patterns'] ?? [];

      if (!$service || empty($patterns)) {
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
        continue;
      }

      $prefix = "{$projectName}.{$service}";
      $archiveName = $this->generateArchiveName($prefix);
      $archivePath = rtrim($destination, '/') . '/' . $archiveName;

      if (!$this->createArchive($archivePath, $hostPaths)) {
        $results[] = "Failed to create archive for service '{$service}'";
        $allSuccess = false;
        continue;
      }

      $this->pruneOldBackups($destination, $prefix, $retention);
      $results[] = "Backed up service '{$service}': {$archiveName}";
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

    // Only allow deleting files within the backup destination.
    // pathIsWithin() anchors on a trailing separator; a bare strpos() prefix
    // test would accept a sibling directory such as "<dest>-evil".
    if (!$realFile || !$realDest || !pathIsWithin($realFile, $realDest)) {
      return false;
    }

    if (file_exists($filePath) && is_file($filePath)) {
      return unlink($filePath);
    }

    return false;
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
    $containers = $this->dockerClient->listContainers(true);
    foreach ($containers as $c) {
      if ($c['name'] === $containerName) {
        return $this->resolveHostPathsForContainer($c['id'], $patterns);
      }
    }
    return [];
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
      foreach ($mounts as $mount) {
        $dest = rtrim($mount['Destination'], '/');
        $src = rtrim($mount['Source'], '/');

        if ($pattern === $dest || $pattern === $dest . '/') {
          // Exact mount match
          $hostPaths[] = $src;
          break;
        }

        // Pattern is a subpath of a mount destination
        if (strpos($pattern, $dest . '/') === 0) {
          $relative = substr($pattern, strlen($dest) + 1);

          // $relative comes from user-supplied backup_config.paths and could
          // otherwise climb back out of the mount source with "..".
          if (in_array('..', explode('/', $relative), true)) {
            break;
          }

          $hostPath = $src . '/' . $relative;

          // Support glob patterns
          if (strpos($relative, '*') !== false || strpos($relative, '?') !== false) {
            $globbed = glob($hostPath);
            if ($globbed) {
              foreach ($globbed as $match) {
                if (pathIsWithin($match, $src)) {
                  $hostPaths[] = $match;
                }
              }
            }
          } elseif (pathIsWithin($hostPath, $src) && (file_exists($hostPath) || is_dir($hostPath))) {
            $hostPaths[] = $hostPath;
          }
          break;
        }
      }
    }

    return array_unique($hostPaths);
  }

  private function createArchive($archivePath, $hostPaths)
  {
    $pathArgs = [];
    foreach ($hostPaths as $p) {
      $pathArgs[] = escapeshellarg($p);
    }

    $cmd = 'tar czf ' . escapeshellarg($archivePath) . ' ' . implode(' ', $pathArgs) . ' 2>&1';
    exec($cmd, $output, $exitCode);

    return $exitCode === 0;
  }

  private function pruneOldBackups($destination, $prefix, $retention)
  {
    // Same glob-injection surface as listBackups, but this one unlinks.
    // Must match generateArchiveName's sanitizer so retention still prunes the
    // archives this prefix actually produced.
    $safePrefix = sanitizeArchivePrefix($prefix);
    if ($safePrefix === null) {
      return 0;
    }

    $pattern = rtrim($destination, '/') . '/' . $safePrefix . '.*.tar.gz';
    $files = glob($pattern);

    if (!$files || count($files) <= $retention) {
      return 0;
    }

    usort($files, function ($a, $b) {
      return filemtime($b) - filemtime($a);
    });

    $toDelete = array_slice($files, $retention);
    $deleted = 0;

    foreach ($toDelete as $file) {
      // Re-check containment per file. glob() can follow symlinks out of the
      // destination even with a sanitized prefix.
      if (!pathIsWithin($file, $destination)) {
        continue;
      }
      if (unlink($file)) {
        $deleted++;
      }
    }

    return $deleted;
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
