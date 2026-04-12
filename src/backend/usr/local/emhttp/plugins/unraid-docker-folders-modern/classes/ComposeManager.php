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
  const COMPOSE_SHA256 = 'ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b';

  /** Path where compose_plugin stores its projects */
  const COMPOSE_PLUGIN_PROJECTS = '/boot/config/plugins/compose.manager/projects';

  /** Path to compose_plugin installation */
  const COMPOSE_PLUGIN_DIR = '/usr/local/emhttp/plugins/compose.manager';

  /** Recognised compose file names, in lookup order */
  const COMPOSE_FILENAMES = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
  ];

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
    // Check the DB first — O(1) on an indexed table and avoids touching
    // the /boot flash device on the common "already imported" path.
    $imported = $this->db->fetchOne(
      "SELECT COUNT(*) as cnt FROM compose_stacks WHERE imported_from = 'compose_plugin'"
    );
    if ($imported && (int)$imported['cnt'] > 0) {
      return false;
    }

    // On Unraid, /boot/config/plugins/compose.manager can linger as a
    // stale artifact from a partial install or Community Apps metadata,
    // so require at least one real project subdirectory before prompting.
    return $this->composePluginHasRealProjects();
  }

  private function composePluginHasRealProjects()
  {
    $dirs = @scandir(self::COMPOSE_PLUGIN_PROJECTS);
    if ($dirs === false) {
      return false;
    }

    foreach ($dirs as $dir) {
      if ($dir === '.' || $dir === '..') continue;
      $projectPath = self::COMPOSE_PLUGIN_PROJECTS . '/' . $dir;
      if (!is_dir($projectPath)) continue;

      if (
        file_exists($projectPath . '/name') ||
        file_exists($projectPath . '/indirect') ||
        $this->findComposeFile($projectPath) !== null
      ) {
        return true;
      }
    }

    return false;
  }

  private function findComposeFile($dir)
  {
    $dir = rtrim($dir, '/');
    foreach (self::COMPOSE_FILENAMES as $name) {
      $path = $dir . '/' . $name;
      if (file_exists($path)) {
        return $path;
      }
    }
    return null;
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

      // Always include defined service names from the compose file so the
      // UI can render a faded preview even when the stack is fully down
      // (containers removed, so stackPs returns nothing).
      $stack['service_names'] = $this->parseComposeServiceNames($stack);
    }

    return $stacks;
  }

  /**
   * Read the compose file for a stack and return the list of top-level
   * service names. Uses lightweight YAML parsing so we don't need to shell
   * out to `docker compose config` on every list fetch.
   */
  private function parseComposeServiceNames($stack)
  {
    if (empty($stack['compose_file'])) return [];
    $path = $this->resolveComposeFilePath($stack);
    if (!$path || !file_exists($path)) return [];
    $content = @file_get_contents($path);
    if ($content === false || $content === '') return [];

    $services = [];
    $lines = preg_split("/\r?\n/", $content);
    $inServices = false;
    $baseIndent = null;
    foreach ($lines as $line) {
      // Strip comments
      $stripped = preg_replace('/^([^#]*?)\s*#.*$/', '$1', $line);
      if ($stripped === null) $stripped = $line;

      if (!$inServices) {
        if (preg_match('/^services\s*:\s*$/', $stripped)) {
          $inServices = true;
        }
        continue;
      }

      // Skip blank lines while inside services block
      if (trim($stripped) === '') continue;

      // A non-indented key ends the services block
      if (preg_match('/^\S/', $stripped)) break;

      // Match indented service key (only at the base indent level)
      if (preg_match('/^(\s+)([a-zA-Z0-9._-]+)\s*:\s*$/', $stripped, $m)) {
        $indent = strlen($m[1]);
        if ($baseIndent === null) $baseIndent = $indent;
        if ($indent === $baseIndent) {
          $services[] = $m[2];
        }
      }
    }
    return $services;
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
    $stack['service_names'] = $this->parseComposeServiceNames($stack);

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
   * Create a new compose stack with initial files and folder
   */
  public function createStack($projectName, $composeContent = '', $envContent = '')
  {
    // Validate project name (alphanumeric, hyphens, underscores)
    if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/', $projectName)) {
      return ['success' => false, 'error' => 'Invalid project name. Use only letters, numbers, hyphens, and underscores.'];
    }

    // Check if stack already exists
    $existing = $this->db->fetchOne(
      'SELECT project_name FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );
    if ($existing) {
      return ['success' => false, 'error' => "Stack '{$projectName}' already exists"];
    }

    // Create stack directory
    $stackDir = COMPOSE_STACKS_DIR . '/' . $projectName;
    if (!is_dir($stackDir)) {
      if (!@mkdir($stackDir, 0755, true)) {
        return ['success' => false, 'error' => 'Failed to create stack directory'];
      }
    }

    // Write compose file
    $composeFile = $stackDir . '/docker-compose.yml';
    if (empty($composeContent)) {
      $composeContent = "version: \"3.8\"\nservices:\n  app:\n    image: \n";
    }
    if (@file_put_contents($composeFile, $composeContent) === false) {
      return ['success' => false, 'error' => 'Failed to write compose file'];
    }

    // Write env file if provided
    if (!empty($envContent)) {
      $envFile = $stackDir . '/.env';
      @file_put_contents($envFile, $envContent);
    }

    // Create database record
    $now = time();
    $this->db->insert('compose_stacks', [
      'project_name' => $projectName,
      'working_dir' => $stackDir,
      'compose_file' => $composeFile,
      'env_file' => !empty($envContent) ? $stackDir . '/.env' : null,
      'autostart' => 0,
      'autostart_force_recreate' => 0,
      'description' => null,
      'imported_from' => null,
      'created_at' => $now,
      'updated_at' => $now,
    ]);

    // Create linked folder
    require_once __DIR__ . '/FolderManager.php';
    $folderManager = new FolderManager();
    $existingFolder = $this->db->fetchOne(
      'SELECT id FROM folders WHERE compose_project = ?',
      [$projectName]
    );
    if (!$existingFolder) {
      $folderManager->createFolder([
        'name' => $projectName,
        'icon' => 'layer-group',
        'compose_project' => $projectName,
      ]);
    }

    return ['success' => true, 'project_name' => $projectName];
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
   * Validate compose file content via `docker compose config`.
   * If $content is provided it's written to a temp file and validated; otherwise
   * the project's current file on disk is checked.
   * Returns [ 'success' => bool, 'output' => string, 'errors' => [{line, column, message}] ]
   */
  public function validateComposeContent($projectName, $content = null)
  {
    if (!$this->isComposeAvailable()) {
      return ['success' => false, 'errors' => [['line' => 1, 'message' => 'Docker Compose not available']]];
    }

    // Always resolve the stack so we can pass --env-file and working_dir
    // even when validating unsaved content — required env interpolations
    // would otherwise error out ("variable is required").
    $stack = $this->db->fetchOne(
      'SELECT working_dir, compose_file, env_file FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    $tmpFile = null;
    $cmd = 'docker compose';
    $cmd .= ' -p ' . escapeshellarg($projectName);

    if ($content !== null) {
      $tmpFile = tempnam(sys_get_temp_dir(), 'dfm-compose-');
      if ($tmpFile === false) {
        return ['success' => false, 'errors' => [['line' => 1, 'message' => 'Failed to create temp file']]];
      }
      file_put_contents($tmpFile, $content);
      $cmd .= ' -f ' . escapeshellarg($tmpFile);
      if ($stack && $stack['env_file']) {
        $cmd .= ' --env-file ' . escapeshellarg($stack['env_file']);
      }
      if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
        $cmd .= ' --project-directory ' . escapeshellarg($stack['working_dir']);
      }
    } else {
      if ($stack && $stack['compose_file']) {
        $cmd .= ' -f ' . escapeshellarg($stack['compose_file']);
      }
      if ($stack && $stack['env_file']) {
        $cmd .= ' --env-file ' . escapeshellarg($stack['env_file']);
      }
      if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
        $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
      }
    }

    $cmd .= ' config --quiet 2>&1';
    $result = $this->execCommand($cmd, 30);

    if ($tmpFile) {
      @unlink($tmpFile);
    }

    $errors = [];
    if (!$result['success']) {
      $errors = $this->parseComposeValidationErrors($result['output'] ?: ($result['error'] ?: ''));
      if (empty($errors)) {
        $errors[] = ['line' => 1, 'message' => trim($result['output'] ?: ($result['error'] ?: 'Validation failed'))];
      }
    }

    return [
      'success' => $result['success'],
      'output' => $result['output'] ?: '',
      'errors' => $errors,
    ];
  }

  /**
   * Parse docker compose error output for line numbers.
   * Docker compose emits messages like:
   *   "validating <file>: services.web.image expected type 'string'"
   *   "yaml: line 12: mapping values are not allowed in this context"
   *   "line 5: ..."
   */
  private function parseComposeValidationErrors($output)
  {
    if ($output === '' || $output === null) return [];
    $errors = [];
    $lines = preg_split("/\r?\n/", trim($output));
    foreach ($lines as $line) {
      $line = trim($line);
      if ($line === '') continue;

      // "yaml: line N: msg" or "line N: msg" or "in compose.yaml, line N column C: msg"
      if (preg_match('/line\s+(\d+)(?:\s*,?\s*column\s+(\d+))?[\s:]+(.*)$/i', $line, $m)) {
        $errors[] = [
          'line' => (int) $m[1],
          'column' => isset($m[2]) && $m[2] !== '' ? (int) $m[2] : 1,
          'message' => trim($m[3]),
        ];
        continue;
      }
      // Fall back: attach to line 1 so user sees at least something
      if (stripos($line, 'validating') !== false
          || stripos($line, 'invalid') !== false
          || stripos($line, 'error') !== false) {
        $errors[] = ['line' => 1, 'column' => 1, 'message' => $line];
      }
    }
    return $errors;
  }

  /**
   * Execute a shell command and stream stdout/stderr line-by-line via callback.
   * $onLine receives ($line, $stream) where $stream is 'out' or 'err'.
   */
  private function execCommandStreaming($cmd, $onLine, $timeout = 600)
  {
    $descriptors = [
      0 => ['pipe', 'r'],
      1 => ['pipe', 'w'],
      2 => ['pipe', 'w'],
    ];

    $process = proc_open($cmd, $descriptors, $pipes);
    if (!is_resource($process)) {
      return ['success' => false, 'exit_code' => -1, 'error' => 'Failed to start process'];
    }

    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $start = time();
    $buffers = ['out' => '', 'err' => ''];

    while (true) {
      $status = proc_get_status($process);

      $read = [$pipes[1], $pipes[2]];
      $write = null;
      $except = null;
      $changed = @stream_select($read, $write, $except, 1);

      if ($changed === false) {
        break;
      }

      if ($changed > 0) {
        foreach ($read as $stream) {
          $key = ($stream === $pipes[1]) ? 'out' : 'err';
          $chunk = fread($stream, 8192);
          if ($chunk === false || $chunk === '') {
            continue;
          }
          $buffers[$key] .= $chunk;
          while (($nl = strpos($buffers[$key], "\n")) !== false) {
            $line = rtrim(substr($buffers[$key], 0, $nl), "\r");
            $buffers[$key] = substr($buffers[$key], $nl + 1);
            if ($line !== '') {
              call_user_func($onLine, $line, $key);
            }
          }
        }
      }

      if (!$status['running']) {
        // Drain any remaining bytes
        foreach (['out', 'err'] as $key) {
          $stream = $key === 'out' ? $pipes[1] : $pipes[2];
          $rest = stream_get_contents($stream);
          if ($rest !== false && $rest !== '') {
            $buffers[$key] .= $rest;
          }
          if ($buffers[$key] !== '') {
            foreach (explode("\n", $buffers[$key]) as $line) {
              $line = rtrim($line, "\r");
              if ($line !== '') {
                call_user_func($onLine, $line, $key);
              }
            }
            $buffers[$key] = '';
          }
        }
        break;
      }

      if ($timeout > 0 && (time() - $start) > $timeout) {
        proc_terminate($process);
        $exit = proc_close($process);
        return ['success' => false, 'exit_code' => $exit, 'error' => 'Command timed out'];
      }
    }

    @fclose($pipes[1]);
    @fclose($pipes[2]);
    $exit = proc_close($process);

    return ['success' => $exit === 0, 'exit_code' => $exit];
  }

  /**
   * Pull images then bring up a compose stack, streaming progress via callbacks.
   * $onPhase receives ($phase, $message). $onLine receives ($line, $stream).
   */
  public function stackUpStreaming($projectName, $forceRecreate, $onPhase, $onLine)
  {
    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    $cd = '';
    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ';
    }

    // Phase 1: pull (best-effort — local-build services may not have images)
    call_user_func($onPhase, 'pulling', 'Pulling images...');
    $pullCmd = $cd . $cmd . ' pull 2>&1';
    $pullResult = $this->execCommandStreaming($pullCmd, $onLine, 600);

    if (!$pullResult['success']) {
      // Don't abort — continue to up so locally-built or partial stacks still start
      call_user_func($onPhase, 'pull_warning', 'Pull finished with warnings, continuing...');
    }

    // Phase 2: up
    call_user_func($onPhase, 'starting', 'Starting containers...');
    $upCmd = $cd . $cmd . ' up -d';
    if ($forceRecreate) {
      $upCmd .= ' --force-recreate';
    }
    $upCmd .= ' 2>&1';
    $upResult = $this->execCommandStreaming($upCmd, $onLine, 600);

    return $upResult;
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
   * Stop a compose stack without removing containers (docker compose stop)
   */
  public function stackStop($projectName)
  {
    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
    }

    $cmd .= ' stop 2>&1';

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

    // Snapshot current version before overwriting
    if (file_exists($path)) {
      $currentContent = @file_get_contents($path);
      if ($currentContent !== false) {
        $this->snapshotVersion($projectName, 'compose', $path, $currentContent);
      }
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

    // Snapshot current version before overwriting
    if ($path && file_exists($path)) {
      $currentContent = @file_get_contents($path);
      if ($currentContent !== false && $currentContent !== '') {
        $this->snapshotVersion($projectName, 'env', $path, $currentContent);
      }
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
      $found = $this->findComposeFile($stack['working_dir']);
      if ($found !== null) {
        return $found;
      }
      // Default to docker-compose.yml even if it doesn't exist yet
      return rtrim($stack['working_dir'], '/') . '/docker-compose.yml';
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

  // ─── File Versioning ────────────────────────────────────────────────

  private function snapshotVersion($projectName, $fileType, $sourcePath, $content)
  {
    $hash = md5($content);

    $latest = $this->db->fetchOne(
      'SELECT content_hash FROM compose_file_versions
       WHERE project_name = ? AND file_type = ?
       ORDER BY id DESC LIMIT 1',
      [$projectName, $fileType]
    );

    if ($latest && $latest['content_hash'] === $hash) {
      return;
    }

    $stack = $this->db->fetchOne(
      'SELECT working_dir FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );
    if (!$stack) return;

    $versionsDir = $stack['working_dir'] . '/.versions';
    if (!is_dir($versionsDir)) {
      @mkdir($versionsDir, 0755, true);
    }

    $timestamp = time();
    $ext = $fileType === 'compose' ? 'yml' : 'env';
    $versionFilename = "{$timestamp}-{$fileType}.{$ext}";
    $versionPath = $versionsDir . '/' . $versionFilename;

    if (@file_put_contents($versionPath, $content) === false) {
      return;
    }

    $relativePath = '.versions/' . $versionFilename;

    $this->db->insert('compose_file_versions', [
      'project_name' => $projectName,
      'file_type' => $fileType,
      'file_path' => $relativePath,
      'content_hash' => $hash,
      'created_at' => $timestamp,
    ]);

    $this->pruneVersions($projectName, $fileType);
  }

  private function pruneVersions($projectName, $fileType)
  {
    $maxSetting = $this->db->fetchOne(
      "SELECT value FROM settings WHERE key = 'compose_max_versions'"
    );
    $max = $maxSetting ? (int) $maxSetting['value'] : 10;
    if ($max <= 0) return;

    $count = $this->db->fetchValue(
      'SELECT COUNT(*) FROM compose_file_versions
       WHERE project_name = ? AND file_type = ?',
      [$projectName, $fileType]
    );

    if ($count <= $max) return;

    $stack = $this->db->fetchOne(
      'SELECT working_dir FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    $excess = $this->db->fetchAll(
      'SELECT id, file_path FROM compose_file_versions
       WHERE project_name = ? AND file_type = ?
       ORDER BY id ASC
       LIMIT ?',
      [$projectName, $fileType, $count - $max]
    );

    foreach ($excess as $row) {
      if ($stack) {
        $fullPath = $stack['working_dir'] . '/' . $row['file_path'];
        @unlink($fullPath);
      }
      $this->db->query(
        'DELETE FROM compose_file_versions WHERE id = ?',
        [$row['id']]
      );
    }
  }

  public function getFileVersions($projectName, $fileType = 'compose')
  {
    if (!in_array($fileType, ['compose', 'env'])) {
      return ['success' => false, 'error' => 'Invalid file type', 'versions' => []];
    }

    $versions = $this->db->fetchAll(
      'SELECT id, file_type, file_path, content_hash, created_at
       FROM compose_file_versions
       WHERE project_name = ? AND file_type = ?
       ORDER BY created_at DESC',
      [$projectName, $fileType]
    );

    return ['success' => true, 'versions' => $versions];
  }

  public function getFileVersionContent($projectName, $versionId)
  {
    $version = $this->db->fetchOne(
      'SELECT v.id, v.file_type, v.file_path, v.content_hash, v.created_at, s.working_dir
       FROM compose_file_versions v
       JOIN compose_stacks s ON s.project_name = v.project_name
       WHERE v.id = ? AND v.project_name = ?',
      [$versionId, $projectName]
    );

    if (!$version) {
      return ['success' => false, 'error' => 'Version not found'];
    }

    $fullPath = $version['working_dir'] . '/' . $version['file_path'];
    if (!file_exists($fullPath)) {
      return ['success' => false, 'error' => 'Version file missing from disk'];
    }

    $content = @file_get_contents($fullPath);
    if ($content === false) {
      return ['success' => false, 'error' => 'Failed to read version file'];
    }

    return [
      'success' => true,
      'version' => [
        'id' => $version['id'],
        'file_type' => $version['file_type'],
        'content_hash' => $version['content_hash'],
        'created_at' => $version['created_at'],
        'content' => $content,
      ],
    ];
  }

  public function restoreFileVersion($projectName, $versionId)
  {
    $result = $this->getFileVersionContent($projectName, $versionId);
    if (!$result['success']) {
      return $result;
    }

    $version = $result['version'];

    if ($version['file_type'] === 'compose') {
      return $this->saveComposeFileContent($projectName, $version['content']);
    } else {
      return $this->saveEnvFileContent($projectName, $version['content']);
    }
  }

  public function deleteStackVersionFiles($projectName)
  {
    $stack = $this->db->fetchOne(
      'SELECT working_dir FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );
    if (!$stack) return;

    $versionsDir = $stack['working_dir'] . '/.versions';
    if (is_dir($versionsDir)) {
      $files = @scandir($versionsDir);
      if ($files) {
        foreach ($files as $file) {
          if ($file === '.' || $file === '..') continue;
          @unlink($versionsDir . '/' . $file);
        }
      }
      @rmdir($versionsDir);
    }
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
          $sourceComposeFile = $this->findComposeFile($sourceDir);
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
   * Export all compose stack configs to a target directory
   */
  public function exportConfigs($exportDir = null)
  {
    if (!$exportDir) {
      $exportDir = COMPOSE_STACKS_DIR;
    }

    // Validate path is absolute
    if ($exportDir[0] !== '/') {
      return ['success' => false, 'error' => 'Export directory must be an absolute path'];
    }

    // Create directory if needed
    if (!is_dir($exportDir)) {
      if (!@mkdir($exportDir, 0755, true)) {
        return ['success' => false, 'error' => 'Failed to create export directory: ' . $exportDir];
      }
    }

    if (!is_writable($exportDir)) {
      return ['success' => false, 'error' => 'Export directory is not writable: ' . $exportDir];
    }

    $stacks = $this->db->fetchAll('SELECT project_name FROM compose_stacks');
    $exported = 0;
    $errors = [];

    foreach ($stacks as $stack) {
      $projectName = $stack['project_name'];
      $projectDir = $exportDir . '/' . $projectName;

      if (!is_dir($projectDir)) {
        if (!@mkdir($projectDir, 0755, true)) {
          $errors[] = "Failed to create directory for $projectName";
          continue;
        }
      }

      // Copy compose file
      $compose = $this->getComposeFileContent($projectName);
      if ($compose['success'] && !empty($compose['content'])) {
        $filename = basename($compose['path'] ?? 'docker-compose.yml');
        if (@file_put_contents($projectDir . '/' . $filename, $compose['content']) === false) {
          $errors[] = "Failed to write compose file for $projectName";
          continue;
        }
      }

      // Copy env file
      $env = $this->getEnvFileContent($projectName);
      if ($env['success'] && !empty($env['content'])) {
        if (@file_put_contents($projectDir . '/.env', $env['content']) === false) {
          $errors[] = "Failed to write env file for $projectName";
        }
      }

      $exported++;
    }

    return [
      'success' => true,
      'exported' => $exported,
      'errors' => $errors,
      'path' => $exportDir,
    ];
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
