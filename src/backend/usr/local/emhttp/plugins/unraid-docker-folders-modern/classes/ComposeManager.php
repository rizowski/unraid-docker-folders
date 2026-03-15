<?php
/**
 * Unraid Docker Folders - Compose Manager
 *
 * Manages Docker Compose stacks: binary detection, stack operations,
 * file I/O, autostart, and migration from compose_plugin.
 *
 * @package UnraidDockerModern
 */

require_once __DIR__ . '/Database.php';

class ComposeManager
{
  private $db;

  /** Where docker compose CLI plugin binary lives */
  const COMPOSE_BINARY_PATH = '/usr/lib/docker/cli-plugins/docker-compose';

  /** Version of Docker Compose to install when missing */
  const COMPOSE_VERSION = '2.32.4';

  /** SHA256 of the linux-x86_64 binary for the above version */
  const COMPOSE_SHA256 = '8d47ce7ca63e5a1e1e3b24ad7c06e47890e5f98d7a4dfd0e82a3af16b6e3b994';

  /** Path where compose_plugin stores its projects */
  const COMPOSE_PLUGIN_PROJECTS = '/boot/config/plugins/compose.manager/projects';

  /** Path to compose_plugin installation */
  const COMPOSE_PLUGIN_DIR = '/usr/local/emhttp/plugins/compose.manager';

  public function __construct()
  {
    $this->db = Database::getInstance();
  }

  // ─── Binary Detection & Installation ───────────────────────────────

  /**
   * Check if docker compose CLI is available
   */
  public function isComposeAvailable()
  {
    $output = [];
    $code = -1;
    @exec('docker compose version 2>&1', $output, $code);
    return $code === 0;
  }

  /**
   * Get docker compose version string
   */
  public function getComposeVersion()
  {
    $output = [];
    $code = -1;
    @exec('docker compose version --short 2>&1', $output, $code);
    if ($code === 0 && !empty($output)) {
      return trim($output[0]);
    }
    return null;
  }

  /**
   * Download and install Docker Compose CLI plugin binary
   *
   * @return array ['success' => bool, 'error' => string|null]
   */
  public function installComposeBinary()
  {
    $url = 'https://github.com/docker/compose/releases/download/v'
      . self::COMPOSE_VERSION . '/docker-compose-linux-x86_64';

    $dir = dirname(self::COMPOSE_BINARY_PATH);
    if (!is_dir($dir)) {
      if (!@mkdir($dir, 0755, true)) {
        return ['success' => false, 'error' => 'Failed to create directory: ' . $dir];
      }
    }

    $tmpPath = self::COMPOSE_BINARY_PATH . '.tmp';

    // Download
    $ch = curl_init($url);
    $fp = fopen($tmpPath, 'w');
    if (!$fp) {
      return ['success' => false, 'error' => 'Failed to open temp file for writing'];
    }

    curl_setopt_array($ch, [
      CURLOPT_FILE => $fp,
      CURLOPT_FOLLOWLOCATION => true,
      CURLOPT_TIMEOUT => 120,
      CURLOPT_CONNECTTIMEOUT => 10,
      CURLOPT_FAILONERROR => true,
    ]);

    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    fclose($fp);

    if (!$result || $httpCode >= 400) {
      @unlink($tmpPath);
      return ['success' => false, 'error' => 'Download failed: ' . $curlError . ' (HTTP ' . $httpCode . ')'];
    }

    // Verify SHA256
    $hash = hash_file('sha256', $tmpPath);
    if ($hash !== self::COMPOSE_SHA256) {
      @unlink($tmpPath);
      return ['success' => false, 'error' => 'SHA256 verification failed. Expected: ' . self::COMPOSE_SHA256 . ', got: ' . $hash];
    }

    // Move into place and set permissions
    if (!@rename($tmpPath, self::COMPOSE_BINARY_PATH)) {
      @unlink($tmpPath);
      return ['success' => false, 'error' => 'Failed to move binary into place'];
    }

    @chmod(self::COMPOSE_BINARY_PATH, 0755);

    return ['success' => true, 'error' => null];
  }

  // ─── Conflict Detection ────────────────────────────────────────────

  /**
   * Check if dcflachs/compose_plugin is installed
   */
  public function isComposePluginInstalled()
  {
    return is_dir(self::COMPOSE_PLUGIN_DIR);
  }

  /**
   * Check if compose_plugin project data exists (for migration)
   */
  public function hasComposePluginData()
  {
    return is_dir(self::COMPOSE_PLUGIN_PROJECTS);
  }

  /**
   * Get full compose status for frontend
   */
  public function getStatus()
  {
    $available = $this->isComposeAvailable();
    $pluginInstalled = $this->isComposePluginInstalled();

    return [
      'compose_available' => $available,
      'compose_version' => $available ? $this->getComposeVersion() : null,
      'compose_plugin_installed' => $pluginInstalled,
      'management_enabled' => $available && !$pluginInstalled,
      'compose_plugin_data_exists' => $this->hasComposePluginData(),
    ];
  }

  // ─── Stack CRUD ────────────────────────────────────────────────────

  /**
   * Get all compose stacks with runtime status
   */
  public function getAllStacks()
  {
    $stacks = $this->db->fetchAll('SELECT * FROM compose_stacks ORDER BY project_name ASC');

    foreach ($stacks as &$stack) {
      $stack['autostart'] = (bool) $stack['autostart'];
      $stack['autostart_force_recreate'] = (bool) $stack['autostart_force_recreate'];

      // Get runtime service counts
      $ps = $this->stackPs($stack['project_name']);
      $stack['services_total'] = count($ps);
      $stack['services_running'] = 0;
      foreach ($ps as $svc) {
        if (isset($svc['State']) && $svc['State'] === 'running') {
          $stack['services_running']++;
        }
      }
    }

    return $stacks;
  }

  /**
   * Get a single compose stack by project name
   */
  public function getStack($projectName)
  {
    $stack = $this->db->fetchOne(
      'SELECT * FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    if (!$stack) {
      return null;
    }

    $stack['autostart'] = (bool) $stack['autostart'];
    $stack['autostart_force_recreate'] = (bool) $stack['autostart_force_recreate'];

    $ps = $this->stackPs($projectName);
    $stack['services_total'] = count($ps);
    $stack['services_running'] = 0;
    foreach ($ps as $svc) {
      if (isset($svc['State']) && $svc['State'] === 'running') {
        $stack['services_running']++;
      }
    }

    return $stack;
  }

  /**
   * Upsert a compose stack record (called from syncComposeStacks)
   */
  public function upsertStack($projectName, $workingDir, $composeFile)
  {
    $existing = $this->db->fetchOne(
      'SELECT project_name FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    $now = time();

    if ($existing) {
      // Only update paths if they changed (don't overwrite user settings)
      $updates = ['updated_at' => $now];
      if ($workingDir) {
        $updates['working_dir'] = $workingDir;
      }
      if ($composeFile) {
        $updates['compose_file'] = $composeFile;
      }
      $this->db->update('compose_stacks', $updates, 'project_name = ?', [$projectName]);
    } else {
      $this->db->insert('compose_stacks', [
        'project_name' => $projectName,
        'working_dir' => $workingDir,
        'compose_file' => $composeFile,
        'env_file' => null,
        'autostart' => 0,
        'autostart_force_recreate' => 0,
        'description' => null,
        'imported_from' => null,
        'created_at' => $now,
        'updated_at' => $now,
      ]);
    }
  }

  /**
   * Update autostart settings for a stack
   */
  public function setAutostart($projectName, $enabled, $forceRecreate = false)
  {
    return $this->db->update('compose_stacks', [
      'autostart' => $enabled ? 1 : 0,
      'autostart_force_recreate' => $forceRecreate ? 1 : 0,
      'updated_at' => time(),
    ], 'project_name = ?', [$projectName]);
  }

  /**
   * Update env file path for a stack
   */
  public function setEnvFilePath($projectName, $path)
  {
    return $this->db->update('compose_stacks', [
      'env_file' => $path,
      'updated_at' => time(),
    ], 'project_name = ?', [$projectName]);
  }

  /**
   * Update description for a stack
   */
  public function setDescription($projectName, $description)
  {
    return $this->db->update('compose_stacks', [
      'description' => $description,
      'updated_at' => time(),
    ], 'project_name = ?', [$projectName]);
  }

  // ─── Stack Operations (docker compose CLI) ─────────────────────────

  /**
   * Build the base docker compose command for a project
   */
  private function buildComposeCmd($projectName)
  {
    $stack = $this->db->fetchOne(
      'SELECT working_dir, compose_file, env_file FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    $cmd = 'docker compose';
    $cmd .= ' -p ' . escapeshellarg($projectName);

    if ($stack && $stack['compose_file']) {
      $cmd .= ' -f ' . escapeshellarg($stack['compose_file']);
    }

    if ($stack && $stack['env_file']) {
      $cmd .= ' --env-file ' . escapeshellarg($stack['env_file']);
    }

    return [$cmd, $stack];
  }

  /**
   * Execute a shell command and return structured result
   */
  private function execCommand($cmd, $timeout = 120)
  {
    $descriptors = [
      0 => ['pipe', 'r'],
      1 => ['pipe', 'w'],
      2 => ['pipe', 'w'],
    ];

    $env = null;
    $cwd = null;

    $process = proc_open($cmd, $descriptors, $pipes, $cwd, $env);

    if (!is_resource($process)) {
      return ['success' => false, 'output' => '', 'error' => 'Failed to start process'];
    }

    fclose($pipes[0]); // Close stdin

    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);

    $exitCode = proc_close($process);

    return [
      'success' => $exitCode === 0,
      'output' => $stdout,
      'error' => $exitCode !== 0 ? $stderr : null,
      'exit_code' => $exitCode,
    ];
  }

  /**
   * Start a compose stack (docker compose up -d)
   */
  public function stackUp($projectName, $forceRecreate = false)
  {
    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    // Change to working directory if available
    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
    }

    $cmd .= ' up -d';
    if ($forceRecreate) {
      $cmd .= ' --force-recreate';
    }

    $cmd .= ' 2>&1';

    return $this->execCommand($cmd);
  }

  /**
   * Stop a compose stack (docker compose down)
   */
  public function stackDown($projectName)
  {
    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
    }

    $cmd .= ' down 2>&1';

    return $this->execCommand($cmd);
  }

  /**
   * Restart a compose stack (down then up)
   */
  public function stackRestart($projectName)
  {
    $downResult = $this->stackDown($projectName);
    if (!$downResult['success']) {
      return $downResult;
    }

    $upResult = $this->stackUp($projectName);
    $upResult['output'] = $downResult['output'] . "\n" . $upResult['output'];
    return $upResult;
  }

  /**
   * Pull latest images for a compose stack
   */
  public function stackPull($projectName)
  {
    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
    }

    $cmd .= ' pull 2>&1';

    return $this->execCommand($cmd, 300); // 5 min timeout for pulls
  }

  /**
   * Get logs from a compose stack
   */
  public function stackLogs($projectName, $tail = 100)
  {
    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
    }

    $tail = max(1, min((int) $tail, 5000));
    $cmd .= ' logs --no-color --tail=' . $tail . ' 2>&1';

    return $this->execCommand($cmd, 30);
  }

  /**
   * List services and their status (docker compose ps --format json)
   */
  public function stackPs($projectName)
  {
    if (!$this->isComposeAvailable()) {
      return [];
    }

    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
    }

    $cmd .= ' ps --format json 2>/dev/null';

    $result = $this->execCommand($cmd, 10);

    if (!$result['success'] || empty($result['output'])) {
      return [];
    }

    // docker compose ps --format json outputs one JSON object per line
    $services = [];
    foreach (explode("\n", trim($result['output'])) as $line) {
      $line = trim($line);
      if ($line === '') continue;
      $svc = json_decode($line, true);
      if ($svc) {
        $services[] = $svc;
      }
    }

    return $services;
  }

  // ─── File I/O ──────────────────────────────────────────────────────

  /**
   * Get the compose file content for a project
   */
  public function getComposeFileContent($projectName)
  {
    $stack = $this->db->fetchOne(
      'SELECT working_dir, compose_file FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    if (!$stack) {
      return ['success' => false, 'error' => 'Stack not found', 'content' => null, 'path' => null];
    }

    // Determine the file path
    $path = $this->resolveComposeFilePath($stack);

    if (!$path || !file_exists($path)) {
      return ['success' => false, 'error' => 'Compose file not found at: ' . ($path ?? 'unknown'), 'content' => null, 'path' => $path];
    }

    $content = @file_get_contents($path);
    if ($content === false) {
      return ['success' => false, 'error' => 'Failed to read compose file', 'content' => null, 'path' => $path];
    }

    return ['success' => true, 'error' => null, 'content' => $content, 'path' => $path];
  }

  /**
   * Save compose file content for a project
   */
  public function saveComposeFileContent($projectName, $content)
  {
    $stack = $this->db->fetchOne(
      'SELECT working_dir, compose_file FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    if (!$stack) {
      return ['success' => false, 'error' => 'Stack not found'];
    }

    $path = $this->resolveComposeFilePath($stack);

    if (!$path) {
      return ['success' => false, 'error' => 'Cannot determine compose file path'];
    }

    // Ensure directory exists
    $dir = dirname($path);
    if (!is_dir($dir)) {
      @mkdir($dir, 0755, true);
    }

    $result = @file_put_contents($path, $content);
    if ($result === false) {
      return ['success' => false, 'error' => 'Failed to write compose file'];
    }

    return ['success' => true, 'error' => null, 'path' => $path];
  }

  /**
   * Get the env file content for a project
   */
  public function getEnvFileContent($projectName)
  {
    $stack = $this->db->fetchOne(
      'SELECT working_dir, env_file FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    if (!$stack) {
      return ['success' => false, 'error' => 'Stack not found', 'content' => null, 'path' => null];
    }

    $path = $this->resolveEnvFilePath($stack);

    if (!$path || !file_exists($path)) {
      // Env file is optional — return empty content, not an error
      return ['success' => true, 'error' => null, 'content' => '', 'path' => $path];
    }

    $content = @file_get_contents($path);
    if ($content === false) {
      return ['success' => false, 'error' => 'Failed to read env file', 'content' => null, 'path' => $path];
    }

    return ['success' => true, 'error' => null, 'content' => $content, 'path' => $path];
  }

  /**
   * Save env file content for a project
   */
  public function saveEnvFileContent($projectName, $content)
  {
    $stack = $this->db->fetchOne(
      'SELECT working_dir, env_file FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    if (!$stack) {
      return ['success' => false, 'error' => 'Stack not found'];
    }

    $path = $this->resolveEnvFilePath($stack);

    if (!$path) {
      return ['success' => false, 'error' => 'Cannot determine env file path'];
    }

    $dir = dirname($path);
    if (!is_dir($dir)) {
      @mkdir($dir, 0755, true);
    }

    $result = @file_put_contents($path, $content);
    if ($result === false) {
      return ['success' => false, 'error' => 'Failed to write env file'];
    }

    return ['success' => true, 'error' => null, 'path' => $path];
  }

  /**
   * Resolve the actual compose file path from stack metadata
   */
  private function resolveComposeFilePath($stack)
  {
    // Explicit compose_file path takes priority
    if (!empty($stack['compose_file'])) {
      $path = $stack['compose_file'];
      // If relative, resolve against working_dir
      if ($path[0] !== '/' && !empty($stack['working_dir'])) {
        $path = rtrim($stack['working_dir'], '/') . '/' . $path;
      }
      return $path;
    }

    // Fall back to working_dir + common filenames
    if (!empty($stack['working_dir'])) {
      $dir = rtrim($stack['working_dir'], '/');
      foreach (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as $name) {
        if (file_exists($dir . '/' . $name)) {
          return $dir . '/' . $name;
        }
      }
      // Default to docker-compose.yml even if it doesn't exist yet
      return $dir . '/docker-compose.yml';
    }

    return null;
  }

  /**
   * Resolve the actual env file path from stack metadata
   */
  private function resolveEnvFilePath($stack)
  {
    // Explicit env_file path
    if (!empty($stack['env_file'])) {
      $path = $stack['env_file'];
      if ($path[0] !== '/' && !empty($stack['working_dir'])) {
        $path = rtrim($stack['working_dir'], '/') . '/' . $path;
      }
      return $path;
    }

    // Default to .env in working_dir
    if (!empty($stack['working_dir'])) {
      return rtrim($stack['working_dir'], '/') . '/.env';
    }

    return null;
  }

  // ─── Autostart ─────────────────────────────────────────────────────

  /**
   * Get all stacks with autostart enabled
   */
  public function getAutostartStacks()
  {
    return $this->db->fetchAll('SELECT * FROM compose_stacks WHERE autostart = 1');
  }

  /**
   * Start all autostart stacks (called by event hook)
   */
  public function startAutostartStacks()
  {
    if (!$this->isComposeAvailable()) {
      error_log('ComposeManager: docker compose not available, skipping autostart');
      return [];
    }

    $stacks = $this->getAutostartStacks();
    $results = [];

    foreach ($stacks as $stack) {
      $forceRecreate = (bool) $stack['autostart_force_recreate'];
      $result = $this->stackUp($stack['project_name'], $forceRecreate);
      $results[$stack['project_name']] = $result;

      $status = $result['success'] ? 'OK' : 'FAILED';
      error_log('ComposeManager autostart: ' . $stack['project_name'] . ' - ' . $status);
    }

    return $results;
  }

  /**
   * Stop all autostart stacks (called by event hook on docker stop)
   */
  public function stopAutostartStacks()
  {
    if (!$this->isComposeAvailable()) {
      return [];
    }

    $stacks = $this->getAutostartStacks();
    $results = [];

    foreach ($stacks as $stack) {
      $result = $this->stackDown($stack['project_name']);
      $results[$stack['project_name']] = $result;

      $status = $result['success'] ? 'OK' : 'FAILED';
      error_log('ComposeManager shutdown: ' . $stack['project_name'] . ' - ' . $status);
    }

    return $results;
  }

  // ─── Migration from compose_plugin ─────────────────────────────────

  /**
   * Import projects from dcflachs/compose_plugin
   *
   * Reads project data from the compose_plugin directory.
   * Never modifies the source plugin's files.
   */
  public function importFromComposePlugin()
  {
    $result = [
      'success' => true,
      'stacks_imported' => 0,
      'stacks_skipped' => 0,
      'errors' => [],
    ];

    if (!is_dir(self::COMPOSE_PLUGIN_PROJECTS)) {
      $result['success'] = false;
      $result['errors'][] = 'Compose plugin projects directory not found';
      return $result;
    }

    $dirs = @scandir(self::COMPOSE_PLUGIN_PROJECTS);
    if ($dirs === false) {
      $result['success'] = false;
      $result['errors'][] = 'Failed to scan compose plugin projects directory';
      return $result;
    }

    $this->db->beginTransaction();

    try {
      foreach ($dirs as $dir) {
        if ($dir === '.' || $dir === '..') continue;

        $projectPath = self::COMPOSE_PLUGIN_PROJECTS . '/' . $dir;
        if (!is_dir($projectPath)) continue;

        $projectName = $dir;

        // Check if already imported
        $existing = $this->db->fetchOne(
          'SELECT project_name FROM compose_stacks WHERE project_name = ?',
          [$projectName]
        );
        if ($existing) {
          $result['stacks_skipped']++;
          continue;
        }

        // Read metadata files
        $name = $this->readMetadataFile($projectPath . '/name');
        $description = $this->readMetadataFile($projectPath . '/description');
        $autostart = strtolower(trim($this->readMetadataFile($projectPath . '/autostart') ?? '')) === 'true';
        $isIndirect = file_exists($projectPath . '/indirect');

        // Determine source compose file path and working directory
        $sourceDir = null;
        $sourceComposeFile = null;

        if ($isIndirect) {
          // Indirect: the file contains a path to the actual compose location
          $indirectPath = $this->readMetadataFile($projectPath . '/indirect');
          if ($indirectPath && is_dir($indirectPath)) {
            $sourceDir = $indirectPath;
          }
        } else {
          // Direct: compose file is in the project directory
          $sourceDir = $projectPath;
        }

        // Find actual compose file in source
        if ($sourceDir) {
          foreach (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as $candidate) {
            if (file_exists($sourceDir . '/' . $candidate)) {
              $sourceComposeFile = $sourceDir . '/' . $candidate;
              break;
            }
          }
        }

        // Copy files into our own plugin directory so stacks are self-contained
        $destDir = COMPOSE_STACKS_DIR . '/' . $projectName;
        if (!is_dir($destDir)) {
          @mkdir($destDir, 0755, true);
        }

        $workingDir = $destDir;
        $composeFile = null;
        $envFile = null;

        if ($sourceComposeFile && file_exists($sourceComposeFile)) {
          $destFile = $destDir . '/' . basename($sourceComposeFile);
          if (@copy($sourceComposeFile, $destFile)) {
            $composeFile = $destFile;
          } else {
            $result['errors'][] = $projectName . ': failed to copy compose file';
          }
        }

        // Copy .env if it exists in source
        if ($sourceDir && file_exists($sourceDir . '/.env')) {
          $destEnv = $destDir . '/.env';
          if (@copy($sourceDir . '/.env', $destEnv)) {
            $envFile = $destEnv;
          }
        }

        $now = time();

        // Insert compose_stacks row
        $this->db->insert('compose_stacks', [
          'project_name' => $projectName,
          'working_dir' => $workingDir,
          'compose_file' => $composeFile,
          'env_file' => $envFile,
          'autostart' => $autostart ? 1 : 0,
          'autostart_force_recreate' => 0,
          'description' => $description ?: ($name ?: null),
          'imported_from' => 'compose_plugin',
          'created_at' => $now,
          'updated_at' => $now,
        ]);

        // Create a folder if one doesn't exist for this project
        $existingFolder = $this->db->fetchOne(
          'SELECT id FROM folders WHERE compose_project = ?',
          [$projectName]
        );

        if (!$existingFolder) {
          $maxPosition = $this->db->fetchValue('SELECT MAX(position) FROM folders') ?? -1;
          $this->db->insert('folders', [
            'name' => $name ?: $projectName,
            'icon' => 'layer-group',
            'color' => null,
            'position' => $maxPosition + 1,
            'collapsed' => 0,
            'compose_project' => $projectName,
            'created_at' => $now,
            'updated_at' => $now,
          ]);
        }

        $result['stacks_imported']++;
      }

      $this->db->commit();
    } catch (Exception $e) {
      $this->db->rollback();
      $result['success'] = false;
      $result['errors'][] = $e->getMessage();
    }

    return $result;
  }

  /**
   * Read a metadata text file, returning trimmed content or null
   */
  private function readMetadataFile($path)
  {
    if (!file_exists($path)) {
      return null;
    }
    $content = @file_get_contents($path);
    if ($content === false) {
      return null;
    }
    return trim($content);
  }
}
