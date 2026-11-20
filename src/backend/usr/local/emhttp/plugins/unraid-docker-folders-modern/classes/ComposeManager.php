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
require_once __DIR__ . '/ComposeProjectName.php';

class ComposeManager
{
  private $db;

  /** Where docker compose CLI plugin binary lives */
  const COMPOSE_BINARY_PATH = '/usr/lib/docker/cli-plugins/docker-compose';

  /**
   * Flash copy of the verified binary. /usr/lib is RAM, so the binary is gone
   * after every reboot; this copy lets boot restore it without a download.
   */
  const COMPOSE_CACHE_PATH = CONFIG_DIR . '/docker-compose';

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

  /**
   * Seconds that up, down, stop, and pull may run. "up -d" pulls any missing
   * image first, which takes minutes on a slow link. Matches
   * execCommandStreaming().
   */
  const STACK_COMMAND_TIMEOUT = 600;

  // The answer of "docker compose version", or null before the first ask.
  // See isComposeAvailable().
  private $composeAvailable = null;

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
    // getAllStacks() calls stackPs() once per stack, and each asked again,
    // which ran "docker compose version" once per stack on every list. Both
    // answers are kept. installComposeBinary() clears the answer, because a
    // no can turn into a yes within the same request.
    if ($this->composeAvailable !== null) {
      return $this->composeAvailable;
    }

    $output = [];
    $code = -1;
    @exec('docker compose version 2>&1', $output, $code);
    $this->composeAvailable = $code === 0;
    return $this->composeAvailable;
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
   * @param bool $persist true for an install the user started (the banner's
   *   button): a successful install then turns on compose_auto_install when
   *   the user never chose a value (no stored row), so the flash copy is kept
   *   and restored at boot. A stored off stays off, and then no flash copy is
   *   written. The boot hook leaves it
   *   false, so a restore never switches the setting on by itself, and a user
   *   who turned it off keeps it off until they install again.
   * @return array ['success' => bool, 'error' => string|null, 'warning' => string (only when the flash copy or the setting failed; both facts when both did)]
   */
  public function installComposeBinary($persist = false)
  {
    $url = 'https://github.com/docker/compose/releases/download/v'
      . self::COMPOSE_VERSION . '/docker-compose-linux-x86_64';

    $binary = $this->binaryPath();
    $sha = $this->binarySha256();

    $dir = dirname($binary);
    if (!is_dir($dir)) {
      if (!@mkdir($dir, 0755, true)) {
        return ['success' => false, 'error' => 'Failed to create directory: ' . $dir];
      }
    }

    $tmpPath = $binary . '.tmp';

    $download = $this->downloadFile($url, $tmpPath);
    if (!$download['success']) {
      return $download;
    }

    // Verify SHA256
    $hash = hash_file('sha256', $tmpPath);
    if ($hash !== $sha) {
      @unlink($tmpPath);
      return ['success' => false, 'error' => 'SHA256 verification failed. Expected: ' . $sha . ', got: ' . $hash];
    }

    // Move into place and set permissions
    if (!@rename($tmpPath, $binary)) {
      @unlink($tmpPath);
      return ['success' => false, 'error' => 'Failed to move binary into place'];
    }

    @chmod($binary, 0755);
    $this->composeAvailable = null;

    // Turn the setting on only when the user never chose. A stored value,
    // on or off, is their choice, and an install must not override it.
    // The binary is already in place, so a settings failure here must not
    // fail the install: it becomes a warning.
    $warnings = [];
    $settingFailed = false;
    $autoInstall = false;
    try {
      if ($persist && !$this->hasAutoInstallChoice()) {
        $this->enableAutoInstall();
      }
    } catch (\Throwable $e) {
      error_log('Docker Folders: could not save compose_auto_install: ' . $e->getMessage());
      $settingFailed = true;
    }
    try {
      $autoInstall = $this->isAutoInstallEnabled();
    } catch (\Throwable $e) {
      error_log('Docker Folders: could not read compose_auto_install: ' . $e->getMessage());
      $settingFailed = true;
    }
    if ($settingFailed) {
      $warnings[] = self::SETTING_SAVE_WARNING;
    }

    if ($autoInstall) {
      $cached = $this->cacheComposeBinary($binary, $this->cachePath(), $sha, true);
      if (!$cached['success']) {
        error_log('Docker Folders: no flash copy of Docker Compose: ' . $cached['error']);
        // The install worked. Say that the copy did not, so the user is not
        // told Compose survives a reboot when it only does by a new download.
        $warnings[] = self::FLASH_COPY_WARNING;
      }
    }

    $result = ['success' => true, 'error' => null];
    if ($warnings) {
      $result['warning'] = implode(' ', $warnings);
    }

    return $result;
  }

  /** Shown when Compose installed but the copy on the flash drive could not be written. */
  const FLASH_COPY_WARNING = 'Docker Compose is installed, but the copy on the flash drive failed, so it is downloaded again at boot.';

  /** Shown when Compose installed but the reinstall-after-reboot setting could not be saved or read. */
  const SETTING_SAVE_WARNING = 'Docker Compose is installed, but the setting to reinstall it after a reboot could not be saved.';

  // Seams for the install: the tests replace them, the plugin never does.

  protected function binaryPath()
  {
    return self::COMPOSE_BINARY_PATH;
  }

  protected function cachePath()
  {
    return self::COMPOSE_CACHE_PATH;
  }

  protected function binarySha256()
  {
    return self::COMPOSE_SHA256;
  }

  /**
   * Download $url to $dest.
   *
   * @return array ['success' => bool, 'error' => string|null]
   */
  protected function downloadFile($url, $dest)
  {
    $ch = curl_init($url);
    $fp = fopen($dest, 'w');
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
      @unlink($dest);
      return ['success' => false, 'error' => 'Download failed: ' . $curlError . ' (HTTP ' . $httpCode . ')'];
    }

    return ['success' => true, 'error' => null];
  }

  // ─── Reinstall after reboot ────────────────────────────────────────

  /**
   * Whether the user asked for compose to be put back whenever Docker starts
   */
  public function isAutoInstallEnabled()
  {
    $row = $this->db->fetchOne("SELECT value FROM settings WHERE key = 'compose_auto_install'");
    return $row && $row['value'] === '1';
  }

  /**
   * Whether the user ever chose a value for compose_auto_install. No
   * migration or default seeds the row, so a row exists only after the
   * Settings checkbox or a banner install wrote it.
   */
  public function hasAutoInstallChoice()
  {
    return (bool) $this->db->fetchOne("SELECT value FROM settings WHERE key = 'compose_auto_install'");
  }

  /**
   * Turn compose_auto_install on. Only a successful user-started install
   * calls this.
   */
  public function enableAutoInstall()
  {
    dfmUpsertSetting($this->db, 'compose_auto_install', '1');
  }

  /**
   * Copy a verified binary to flash so a reboot can restore it offline.
   * The copy is only made when it matches the pinned SHA256.
   *
   * A copy of the same size already on flash is kept without reading it back:
   * it was verified when it was written, and restoreComposeBinary() checks
   * its hash again before it is used. Reading 65 MB from a USB stick here
   * would only slow the settings request.
   *
   * @param bool $sourceVerified true when the caller just checked $source
   *   against $sha, as installComposeBinary() does, so it is not hashed twice
   * @return array ['success' => bool, 'error' => string|null]
   */
  public function cacheComposeBinary($source = self::COMPOSE_BINARY_PATH, $dest = self::COMPOSE_CACHE_PATH, $sha = self::COMPOSE_SHA256, $sourceVerified = false)
  {
    if (!is_file($source)) {
      return ['success' => false, 'error' => 'Docker Compose is not installed'];
    }
    if (!$sourceVerified && hash_file('sha256', $source) !== $sha) {
      return [
        'success' => false,
        'error' => 'the installed Docker Compose is not the pinned ' . self::COMPOSE_VERSION . ' build, so no copy was kept',
      ];
    }
    if (is_file($dest) && filesize($dest) === filesize($source)) {
      return ['success' => true, 'error' => null];
    }
    if (!$this->copyExecutable($source, $dest)) {
      return ['success' => false, 'error' => 'the copy could not be written to ' . dirname($dest)];
    }
    return ['success' => true, 'error' => null];
  }

  /**
   * Remove the flash copy (used when the option is switched off), and any
   * half-written copy a concurrent request left behind
   */
  public function removeCachedComposeBinary($dest = self::COMPOSE_CACHE_PATH)
  {
    foreach ([$dest, $dest . '.tmp'] as $file) {
      if (is_file($file)) {
        @unlink($file);
      }
    }
  }

  /**
   * Put the compose binary back in place from the flash copy.
   *
   * @return bool true when the binary was restored
   */
  public function restoreComposeBinary($source = self::COMPOSE_CACHE_PATH, $dest = self::COMPOSE_BINARY_PATH, $sha = self::COMPOSE_SHA256)
  {
    if (!is_file($source) || hash_file('sha256', $source) !== $sha) {
      return false;
    }
    $dir = dirname($dest);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
      return false;
    }
    if (!$this->copyExecutable($source, $dest)) {
      return false;
    }
    $this->composeAvailable = null;
    return true;
  }

  /**
   * Copy through a .tmp file and rename, so a reader never sees half a binary.
   */
  private function copyExecutable($source, $dest)
  {
    $tmp = $dest . '.tmp';
    if (!@copy($source, $tmp)) {
      @unlink($tmp);
      return false;
    }
    @chmod($tmp, 0755);
    if (!@rename($tmp, $dest)) {
      @unlink($tmp);
      return false;
    }
    return true;
  }

  /**
   * Make sure docker compose is usable, for the boot hook. Does nothing
   * unless the compose_auto_install setting is on.
   *
   * @return array ['available' => bool, 'action' => present|restored|installed|disabled|failed, 'error' => string|null]
   */
  public function ensureComposeBinary()
  {
    if ($this->isComposeAvailable()) {
      return ['available' => true, 'action' => 'present', 'error' => null];
    }
    if (!$this->isAutoInstallEnabled()) {
      return ['available' => false, 'action' => 'disabled', 'error' => null];
    }
    $cache = $this->cachePath();
    if ($this->restoreComposeBinary($cache, $this->binaryPath(), $this->binarySha256()) && $this->isComposeAvailable()) {
      return ['available' => true, 'action' => 'restored', 'error' => null];
    }
    // A flash copy that does not match the pinned hash is never used. It is
    // most likely an older pinned version, so a download follows.
    if (is_file($cache) && hash_file('sha256', $cache) !== $this->binarySha256()) {
      error_log('Docker Folders: the flash copy of Docker Compose does not match the pinned SHA256. Treating it as a version change and downloading the pinned release.');
      // Drop it. cacheComposeBinary() keeps a flash copy of the same size
      // without reading it back, so a bad copy of the right size would
      // otherwise stay and fail the restore at every boot.
      $this->removeCachedComposeBinary($cache);
    }

    // The boot hook runs detached (event/started ends its line with &), so
    // waiting here holds up nothing, and stack autostart still follows a late
    // success. The network is often not up yet when Docker starts.
    $waits = self::BOOT_INSTALL_WAITS;
    $attempts = count($waits) + 1;
    $result = ['success' => false, 'error' => 'not tried'];
    for ($try = 1; $try <= $attempts; $try++) {
      // Compose can appear by another route during a wait: the banner's
      // Install button, or another plugin. Do not download over it.
      if ($try > 1 && $this->composeAppearedMeanwhile()) {
        return ['available' => true, 'action' => 'present', 'error' => null];
      }
      $result = $this->installComposeBinary();
      if ($result['success']) {
        break;
      }
      error_log('Docker Folders: Docker Compose download failed (try ' . $try . ' of ' . $attempts . '): ' . $result['error']);
      if ($try < $attempts) {
        $this->waitBeforeRetry($waits[$try - 1]);
      }
    }
    if (!$result['success']) {
      // No false "not reinstalled" notice when it appeared in the meantime.
      if ($this->composeAppearedMeanwhile()) {
        return ['available' => true, 'action' => 'present', 'error' => null];
      }
      // One notification per boot: only after the last try.
      $this->notifyBootInstallFailed($attempts, $result['error']);
      return ['available' => false, 'action' => 'failed', 'error' => $result['error']];
    }
    return ['available' => $this->isComposeAvailable(), 'action' => 'installed', 'error' => null];
  }

  /** Forget the cached availability and ask again. */
  private function composeAppearedMeanwhile()
  {
    $this->composeAvailable = null;
    return (bool) $this->isComposeAvailable();
  }

  /**
   * Seconds to wait after each failed boot download. Four tries, 105 seconds
   * of waiting in all: long enough for a slow network or DNS to come up after
   * Docker starts, short enough that a missing network is reported within
   * minutes. Each try is also capped by the 120 second download timeout.
   */
  const BOOT_INSTALL_WAITS = [15, 30, 60];

  // Seams for the boot retry: the tests replace them.

  protected function waitBeforeRetry($seconds)
  {
    sleep($seconds);
  }

  protected function notifyBootInstallFailed($attempts, $error)
  {
    sendUnraidNotification(
      'Docker Compose was not reinstalled',
      'Docker Compose could not be downloaded after ' . $attempts . ' tries, so compose stacks did not autostart. Last error: ' . $error . ' Install it from the Docker Folders tab.',
      'warning'
    );
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
    // No early return on an empty compose_file. resolveComposeFilePath()
    // falls back to the standard names in working_dir, and a stack known
    // only by its directory has services too.
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
   * True when a container list should not be trusted: it is empty because the
   * Docker request failed. listContainers() answers [] both for "no containers"
   * and for a failure, and only the failure sets lastError.
   *
   * @param array $containers
   * @param string $lastError DockerClient::getLastError()
   * @return bool
   */
  public static function containerListFailed(array $containers, $lastError)
  {
    return empty($containers) && $lastError !== '';
  }

  /**
   * Upsert a compose stack record (called from syncComposeStacks)
   */
  public function upsertStack($projectName, $workingDir, $composeFile)
  {
    $existing = $this->db->fetchOne(
      'SELECT project_name, working_dir, compose_file FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    $now = time();

    if ($existing) {
      // Write only a path that changed. This runs on every container-list
      // GET, so writing unconditionally bumped updated_at on every poll.
      $updates = [];
      if ($workingDir && $workingDir !== $existing['working_dir']) {
        $updates['working_dir'] = $workingDir;
      }
      if ($composeFile && $composeFile !== $existing['compose_file']) {
        $updates['compose_file'] = $composeFile;
      }
      if (!empty($updates)) {
        $updates['updated_at'] = $now;
        $this->db->update('compose_stacks', $updates, 'project_name = ?', [$projectName]);
      }
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
   * Read just the working_dir for a stack.
   *
   * getStack() shells out to `docker compose ps`, which is far too much work
   * when a caller only needs the directory to resolve a path against.
   *
   * @return string|null working_dir, or null when the stack is unknown or the
   *                     compose labels never supplied one
   */
  public function getStackWorkingDir($projectName)
  {
    $row = $this->db->fetchOne(
      'SELECT working_dir FROM compose_stacks WHERE project_name = ?',
      [$projectName]
    );

    if (!$row || empty($row['working_dir'])) {
      return null;
    }

    return $row['working_dir'];
  }

  /**
   * Update env file path for a stack
   *
   * Callers must pass an already-validated absolute path, or null to fall back
   * to the default .env in working_dir. Validation lives at the HTTP boundary
   * in api/compose.php — see the note there for why it cannot live here.
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

    // Read both pipes together, and stop at $timeout. Reading stdout to the
    // end before stderr could hang for good: a command that fills the stderr
    // pipe waits for it to drain while this side waits for stdout to end.
    // $timeout was also accepted and never used.
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $stdout = '';
    $stderr = '';
    $exitCode = null;
    $deadline = time() + $timeout;

    while (true) {
      // A pipe at EOF stays readable, so select would return at once on every
      // pass and the loop would spin. Watch only the pipes still open, and
      // sleep when none is left but the process has not exited yet.
      $read = array_values(array_filter([$pipes[1], $pipes[2]], function ($p) {
        return !feof($p);
      }));
      $write = null;
      $except = null;
      if (empty($read)) {
        usleep(100000);
      } elseif (@stream_select($read, $write, $except, 1) === false) {
        break;
      }
      foreach ($read as $stream) {
        $chunk = fread($stream, 8192);
        if ($chunk === false || $chunk === '') {
          continue;
        }
        if ($stream === $pipes[1]) {
          $stdout .= $chunk;
        } else {
          $stderr .= $chunk;
        }
      }

      $status = proc_get_status($process);
      if (!$status['running']) {
        // proc_get_status() reports the real exit code only once, and older
        // PHP makes proc_close() return -1 after that. Keep this one.
        $exitCode = $status['exitcode'];
        $stdout .= (string) stream_get_contents($pipes[1]);
        $stderr .= (string) stream_get_contents($pipes[2]);
        break;
      }

      if ($timeout > 0 && time() >= $deadline) {
        proc_terminate($process);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);
        return [
          'success' => false,
          'output' => $stdout,
          // proc_terminate() signals only the shell. The command it started,
          // such as docker compose, can still be running.
          'error' => "Command timed out after {$timeout} seconds. It may still be running.",
          'exit_code' => -1,
        ];
      }
    }

    fclose($pipes[1]);
    fclose($pipes[2]);
    $closeCode = proc_close($process);
    if ($exitCode === null) {
      $exitCode = $closeCode;
    }

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
    $cmd = $this->composeCmdFor($projectName);

    // Phase 1: pull (best-effort — local-build services may not have images)
    $pullResult = $this->streamPull($cmd, $onPhase, $onLine);

    if (!$pullResult['success']) {
      // Don't abort — continue to up so locally-built or partial stacks still start
      call_user_func($onPhase, 'pull_warning', 'Pull finished with warnings, continuing...');
    }

    // Phase 2: up
    call_user_func($onPhase, 'starting', 'Starting containers...');
    $upCmd = $cmd . ' up -d';
    if ($forceRecreate) {
      $upCmd .= ' --force-recreate';
    }
    $upCmd .= ' 2>&1';
    $upResult = $this->execCommandStreaming($upCmd, $onLine, 600);

    return $upResult;
  }

  /**
   * Pull the latest images for a compose stack, streaming progress via
   * callbacks. Same first phase as stackUpStreaming(), without the up.
   * $onPhase receives ($phase, $message). $onLine receives ($line, $stream).
   */
  public function stackPullStreaming($projectName, $onPhase, $onLine)
  {
    return $this->streamPull($this->composeCmdFor($projectName), $onPhase, $onLine);
  }

  /**
   * The compose invocation for a stack, prefixed with a cd into its working
   * directory when it has one.
   *
   * @return string
   */
  private function composeCmdFor($projectName)
  {
    list($cmd, $stack) = $this->buildComposeCmd($projectName);

    if ($stack && $stack['working_dir'] && is_dir($stack['working_dir'])) {
      $cmd = 'cd ' . escapeshellarg($stack['working_dir']) . ' && ' . $cmd;
    }

    return $cmd;
  }

  /**
   * Run the pull phase against an already-built compose command.
   *
   * @param string $cmd Output of composeCmdFor()
   * @return array execCommandStreaming() result
   */
  private function streamPull($cmd, $onPhase, $onLine)
  {
    call_user_func($onPhase, 'pulling', 'Pulling images...');

    return $this->execCommandStreaming($cmd . ' pull 2>&1', $onLine, 600);
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

    return $this->execCommand($cmd, self::STACK_COMMAND_TIMEOUT);
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

    return $this->execCommand($cmd, self::STACK_COMMAND_TIMEOUT);
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

    return $this->execCommand($cmd, self::STACK_COMMAND_TIMEOUT);
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

    return $this->execCommand($cmd, self::STACK_COMMAND_TIMEOUT);
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
        $this->snapshotVersion($projectName, 'compose', $currentContent);
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
        $this->snapshotVersion($projectName, 'env', $currentContent);
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

  private function snapshotVersion($projectName, $fileType, $content)
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

    // working_dir is label-derived, so it can be empty or "/". Both would make
    // the containment checks in pruneVersions/getFileVersionContent useless.
    $versionsDir = normalizePath(rtrim((string) $stack['working_dir'], '/') . '/.versions');
    if ($versionsDir === null || !pathIsWithin($versionsDir, $stack['working_dir'])) {
      return;
    }

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
        // file_path is plugin-written and timestamp-based, so this check should
        // never fire in normal operation — which is exactly why it is cheap.
        $fullPath = resolveAgainst($row['file_path'], $stack['working_dir']);
        if ($fullPath !== null && pathIsWithin($fullPath, $stack['working_dir'])) {
          @unlink($fullPath);
        }
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

    // Reachable from a plain GET, so the read must be contained even though both
    // components are plugin-written.
    $fullPath = resolveAgainst($version['file_path'], $version['working_dir']);
    if ($fullPath === null || !pathIsWithin($fullPath, $version['working_dir'])) {
      return ['success' => false, 'error' => 'Version file path is not valid'];
    }

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
   * Adopt the projects of dcflachs/compose_plugin or Compose Manager Plus.
   *
   * Nothing is copied. Each stack gets one compose_stacks row that points at
   * its own folder under the Compose Manager projects directory, the same row
   * the container-list sync creates from the labels of a running stack, so
   * the two resolve to one row and one folder. Never modifies the source
   * plugin's files.
   *
   * The row's project_name is the name the stack runs under, found in this
   * order (see ComposeProjectName):
   * 1. the project label of containers whose working_dir label is the stack's
   *    folder,
   * 2. Compose Manager's own rule (project_name file, else the sanitizer).
   * A stack whose name Compose would refuse, whose containers disagree on the
   * name, or whose name is already a stack at another path is skipped, with an
   * error.
   *
   * Not handled: Compose Manager's override file, its env path file, and a
   * stack with several compose files. Only the first compose file found in
   * the folder is used, as before. A stack whose "indirect" target is missing
   * is skipped.
   *
   * @param array $containers Container list from DockerClient, with labels
   * @param string|null $projectsDir Test hook; every real caller passes nothing
   * @param string|null $pluginDir Test hook; every real caller passes nothing
   * @param string|null $stacksDir Test hook; every real caller passes nothing
   */
  public function importFromComposePlugin(array $containers, $projectsDir = null, $pluginDir = null, $stacksDir = null)
  {
    $projectsDir = $projectsDir ?? self::COMPOSE_PLUGIN_PROJECTS;
    $pluginDir = $pluginDir ?? self::COMPOSE_PLUGIN_DIR;

    $result = [
      'success' => true,
      'stacks_imported' => 0,
      'stacks_skipped' => 0,
      'errors' => [],
    ];

    if (!is_dir($projectsDir)) {
      $result['success'] = false;
      $result['errors'][] = 'Compose plugin projects directory not found';
      return $result;
    }

    $dirs = @scandir($projectsDir);
    if ($dirs === false) {
      $result['success'] = false;
      $result['errors'][] = 'Failed to scan compose plugin projects directory';
      return $result;
    }

    // A copy an earlier version of this import made is merged into its
    // running counterpart, or renamed, first. Whatever stays is left alone,
    // and the loop below must not add a second row for it.
    $this->repairImportedStacks($projectsDir, $pluginDir, $stacksDir);
    $copyDirs = [];
    foreach ($this->importedCopies($stacksDir) as $copy) {
      $copyDirs[$copy['dir']] = true;
    }

    $legacyOrigin = is_file(dirname($projectsDir) . '/legacy-origin');
    $plusInstalled = is_file($pluginDir . '/include/ProjectIdentity.php');

    $plans = [];
    $planned = [];
    foreach ($dirs as $dir) {
      if ($dir === '.' || $dir === '..') continue;

      $projectPath = $projectsDir . '/' . $dir;
      if (!is_dir($projectPath)) continue;

      // Keeps hidden directories such as ".git" out, and any name that is not
      // one path segment.
      if (safeComposeProjectParam($dir) === null) {
        $result['errors'][] = $dir . ': unsupported folder name, skipped';
        continue;
      }

      if (isset($copyDirs[$dir])) {
        $result['errors'][] = $dir . ': an earlier import copied this stack and it could not be matched to the original, so it was left as it is';
        continue;
      }

      $displayName = $this->readMetadataFile($projectPath . '/name');
      $description = $this->readMetadataFile($projectPath . '/description');
      $autostart = strtolower(trim($this->readMetadataFile($projectPath . '/autostart') ?? '')) === 'true';

      $sourceDir = $this->sourceDirOf($projectPath);
      if ($sourceDir === null) {
        $result['errors'][] = $dir . ': its folder is indirect and the target is missing, skipped';
        continue;
      }

      // (1) The name a running stack carries.
      $fromLabels = ComposeProjectName::fromLabels($containers, [$projectPath, $sourceDir]);
      if ($fromLabels['error'] !== null) {
        $result['errors'][] = $dir . ': ' . $fromLabels['error'] . ', skipped';
        continue;
      }
      $projectName = $fromLabels['name'];

      // (2) Compose Manager's own rule.
      if ($projectName === null) {
        $rule = ComposeProjectName::fromFolder(
          $dir,
          $displayName,
          $this->readMetadataFile($projectPath . '/' . ComposeProjectName::PIN_FILE),
          $plusInstalled,
          $legacyOrigin
        );
        if ($rule['name'] === null) {
          $result['errors'][] = $dir . ': no project name Compose accepts (' . $rule['error'] . '), skipped';
          continue;
        }
        $projectName = $rule['name'];
      }

      if (isset($planned[$projectName])) {
        $result['errors'][] = $dir . ': project name "' . $projectName . '" is already taken by the stack in "' . $planned[$projectName] . '", skipped';
        continue;
      }

      $existing = $this->db->fetchOne('SELECT working_dir FROM compose_stacks WHERE project_name = ?', [$projectName]);
      if ($existing && normalizePath((string) $existing['working_dir']) !== normalizePath($sourceDir)) {
        $result['errors'][] = $dir . ': project name "' . $projectName . '" is already a stack at another path, skipped';
        continue;
      }

      $planned[$projectName] = $dir;
      $plans[] = [
        'project' => $projectName,
        'display' => $displayName ?: $dir,
        'description' => $description,
        'autostart' => $autostart,
        'working_dir' => $sourceDir,
        'compose_file' => $this->findComposeFile($sourceDir),
      ];
    }

    if (empty($plans)) {
      return $result;
    }

    $this->db->beginTransaction();

    try {
      foreach ($plans as $plan) {
        $projectName = $plan['project'];
        $now = time();

        // Read inside the transaction: the container-list sync can have added
        // the row since the plan was made. Adopt it instead of adding a second.
        $row = $this->db->fetchOne('SELECT * FROM compose_stacks WHERE project_name = ?', [$projectName]);
        if ($row) {
          $updates = [];
          if ($row['imported_from'] !== 'compose_plugin') {
            $updates['imported_from'] = 'compose_plugin';
          }
          if (empty($row['description']) && ($plan['description'] ?: $plan['display'])) {
            $updates['description'] = $plan['description'] ?: $plan['display'];
          }
          if (!$row['autostart'] && $plan['autostart']) {
            $updates['autostart'] = 1;
          }
          if (empty($row['compose_file']) && $plan['compose_file']) {
            $updates['compose_file'] = $plan['compose_file'];
          }
          if (empty($updates)) {
            $result['stacks_skipped']++;
          } else {
            $updates['updated_at'] = $now;
            $this->db->update('compose_stacks', $updates, 'project_name = ?', [$projectName]);
            $result['stacks_imported']++;
          }
        } else {
          $this->db->insert('compose_stacks', [
            'project_name' => $projectName,
            'working_dir' => $plan['working_dir'],
            'compose_file' => $plan['compose_file'],
            // As the label sync leaves it: the default .env of the folder.
            'env_file' => null,
            'autostart' => $plan['autostart'] ? 1 : 0,
            'autostart_force_recreate' => 0,
            'description' => $plan['description'] ?: $plan['display'],
            'imported_from' => 'compose_plugin',
            'created_at' => $now,
            'updated_at' => $now,
          ]);
          $result['stacks_imported']++;
        }

        // One folder per project name. The sync matches it by compose_project.
        $existingFolder = $this->db->fetchOne(
          'SELECT id FROM folders WHERE compose_project = ?',
          [$projectName]
        );

        if (!$existingFolder) {
          $maxPosition = $this->db->fetchValue('SELECT MAX(position) FROM folders') ?? -1;
          $this->db->insert('folders', [
            'name' => $plan['display'],
            'icon' => 'layer-group',
            'color' => null,
            'position' => $maxPosition + 1,
            'collapsed' => 0,
            'compose_project' => $projectName,
            'created_at' => $now,
            'updated_at' => $now,
          ]);
        }
      }

      $this->db->commit();
    } catch (Exception $e) {
      $this->db->rollback();
      $result['success'] = false;
      $result['stacks_imported'] = 0;
      $result['errors'][] = $e->getMessage();
    }

    return $result;
  }

  /**
   * The directory a Compose Manager project's compose files live in: the
   * folder itself, or the target of its "indirect" file.
   *
   * @return string|null null when an indirect target is missing or relative
   */
  private function sourceDirOf($projectPath)
  {
    if (!file_exists($projectPath . '/indirect')) {
      return $projectPath;
    }
    $target = $this->readMetadataFile($projectPath . '/indirect');
    $target = $target ? normalizePath($target) : null;
    return ($target !== null && is_dir($target)) ? $target : null;
  }

  // ─── Repair of stacks an earlier import copied ─────────────────────

  /**
   * Rows an earlier import made: imported_from is compose_plugin and the
   * files sit in a copy under COMPOSE_STACKS_DIR.
   *
   * @return array[] each ['row' => compose_stacks row, 'dir' => name of the copy's folder]
   */
  private function importedCopies($stacksDir = null)
  {
    $base = normalizePath($stacksDir ?? COMPOSE_STACKS_DIR);
    $copies = [];
    if ($base === null || $base === '/') {
      return $copies;
    }
    foreach ($this->db->fetchAll("SELECT * FROM compose_stacks WHERE imported_from = 'compose_plugin'") as $row) {
      $dir = is_string($row['working_dir']) ? normalizePath($row['working_dir']) : null;
      if ($dir === null || $dir === $base || !pathIsWithin($dir, $base)) {
        continue;
      }
      $rest = substr($dir, strlen($base) + 1);
      $copies[] = ['row' => $row, 'dir' => explode('/', $rest)[0]];
    }
    return $copies;
  }

  /**
   * Merge or rename the rows an earlier import copied, so a stack is one row.
   *
   * Runs on the container-list sync of both backends, so it needs no
   * migration and no menu. It reads one small query on a server that has no
   * such row and then writes nothing.
   *
   * A copy row (imported_from compose_plugin, working_dir inside
   * COMPOSE_STACKS_DIR) is handled in one of three ways:
   * - It has a counterpart, the row for the same Compose Manager stack that
   *   the label sync made: its working_dir is the project folder the copy was
   *   made from (or that folder's indirect target), or its name is what a
   *   Compose Manager name rule makes of the copy's name. Then the
   *   counterpart is kept and the copy's schedules, saved file versions and
   *   folder move to it, and the copy row goes. The folder goes only when it
   *   is empty (a folder with containers in it is detached from the stack
   *   instead). Two counterparts that fit equally leave the row alone.
   * - It has none, the source folder still exists, and the copied compose
   *   file (and .env, when there is one) is byte-identical to the source: the
   *   row is renamed to the name Compose Manager gives the folder and
   *   repointed at it.
   * - Anything else: left alone.
   *
   * Never deletes a file. All writes run in one transaction.
   *
   * @return bool True when anything was written
   */
  public function repairImportedStacks($projectsDir = null, $pluginDir = null, $stacksDir = null)
  {
    $copies = $this->importedCopies($stacksDir);
    if (empty($copies)) {
      return false;
    }

    $projectsDir = $projectsDir ?? self::COMPOSE_PLUGIN_PROJECTS;
    $pluginDir = $pluginDir ?? self::COMPOSE_PLUGIN_DIR;
    $legacyOrigin = is_file(dirname($projectsDir) . '/legacy-origin');
    $plusInstalled = is_file($pluginDir . '/include/ProjectIdentity.php');

    $copyNames = [];
    foreach ($copies as $copy) {
      $copyNames[$copy['row']['project_name']] = true;
    }
    $others = [];
    foreach ($this->db->fetchAll('SELECT * FROM compose_stacks') as $row) {
      if (!isset($copyNames[$row['project_name']])) {
        $others[] = $row;
      }
    }
    $taken = [];
    foreach ($this->db->fetchAll('SELECT project_name FROM compose_stacks') as $row) {
      $taken[$row['project_name']] = true;
    }

    $actions = [];
    foreach ($copies as $copy) {
      $row = $copy['row'];
      $sourcePath = $projectsDir . '/' . $copy['dir'];
      $sourceDir = is_dir($sourcePath) ? $this->sourceDirOf($sourcePath) : null;

      $counterpart = $this->findCounterpart($row, $copy['dir'], $sourceDir, $sourcePath, $others);
      if ($counterpart === false) {
        continue; // two fit equally
      }
      if ($counterpart !== null) {
        $actions[] = ['type' => 'merge', 'from' => $row, 'to' => $counterpart];
        continue;
      }

      if ($sourceDir === null || !$this->copyMatchesSource($row, $sourceDir)) {
        continue;
      }
      $rule = ComposeProjectName::fromFolder(
        $copy['dir'],
        $this->readMetadataFile($sourcePath . '/name'),
        $this->readMetadataFile($sourcePath . '/' . ComposeProjectName::PIN_FILE),
        $plusInstalled,
        $legacyOrigin
      );
      // The copy's own name is not "taken": the row is repointed in place.
      if ($rule['name'] === null || (isset($taken[$rule['name']]) && $rule['name'] !== $row['project_name'])) {
        continue;
      }
      $taken[$rule['name']] = true;
      $actions[] = ['type' => 'rename', 'from' => $row, 'name' => $rule['name'], 'source_dir' => $sourceDir];
    }

    if (empty($actions)) {
      return false;
    }

    // Snapshot files are copied before the transaction: a copy inside it would
    // hold the write lock for the file I/O, and a rollback cannot undo it.
    // Nothing is deleted. The copy of a file that already exists is left.
    foreach ($actions as &$action) {
      $toDir = $action['type'] === 'merge' ? $action['to']['working_dir'] : $action['source_dir'];
      $action['version_paths'] = $this->carryVersionFiles($action['from'], $toDir);
    }
    unset($action);

    $this->db->beginTransaction();
    try {
      foreach ($actions as $action) {
        if ($action['type'] === 'merge') {
          $this->mergeStackRows($action['from'], $action['to'], $action['version_paths']);
        } else {
          $this->renameStackRow($action['from'], $action['name'], $action['source_dir'], $action['version_paths']);
        }
      }
      $this->db->commit();
    } catch (Exception $e) {
      $this->db->rollback();
      error_log('Compose import repair failed: ' . $e->getMessage());
      return false;
    }

    return true;
  }

  /**
   * The row for the same Compose Manager stack as a copy row.
   *
   * @return array|false|null the row; null when none fits; false when more than one does
   */
  private function findCounterpart(array $copyRow, $copyDir, $sourceDir, $sourcePath, array $others)
  {
    $folders = [];
    foreach ([$sourcePath, $sourceDir] as $path) {
      $n = is_string($path) ? normalizePath($path) : null;
      if ($n !== null) {
        $folders[$n] = true;
      }
    }

    // Tier 1: it runs from this stack's folder.
    $byFolder = [];
    foreach ($others as $other) {
      $dir = is_string($other['working_dir']) ? normalizePath($other['working_dir']) : null;
      if ($dir !== null && isset($folders[$dir])) {
        $byFolder[] = $other;
      }
    }
    if (count($byFolder) === 1) {
      return $byFolder[0];
    }
    if (count($byFolder) > 1) {
      return false;
    }

    // Tier 2: the name a Compose Manager rule makes of the imported name.
    $names = [];
    foreach ([ComposeProjectName::plusSanitize($copyRow['project_name']), ComposeProjectName::dcflachsSanitize($copyRow['project_name'])] as $name) {
      if ($name !== null && ComposeProjectName::isValid($name) && $name !== $copyRow['project_name']) {
        $names[$name] = true;
      }
    }
    $byName = [];
    foreach ($others as $other) {
      if (isset($names[$other['project_name']])) {
        $byName[] = $other;
      }
    }
    if (count($byName) === 1) {
      return $byName[0];
    }
    return count($byName) > 1 ? false : null;
  }

  /**
   * Is the copy a row points at the same bytes as the source folder it came
   * from? Checks the compose file, and the .env when the copy has one.
   */
  private function copyMatchesSource(array $row, $sourceDir)
  {
    $copyCompose = is_string($row['compose_file']) ? $row['compose_file'] : null;
    if ($copyCompose === null || !is_file($copyCompose)) {
      return false;
    }
    $sourceCompose = $sourceDir . '/' . basename($copyCompose);
    if (!is_file($sourceCompose) || !self::sameBytes($copyCompose, $sourceCompose)) {
      return false;
    }

    $copyEnv = is_string($row['env_file']) && $row['env_file'] !== '' ? $row['env_file'] : null;
    if ($copyEnv !== null && is_file($copyEnv)) {
      $sourceEnv = $sourceDir . '/' . basename($copyEnv);
      return is_file($sourceEnv) && self::sameBytes($copyEnv, $sourceEnv);
    }
    return true;
  }

  private static function sameBytes($a, $b)
  {
    $x = @file_get_contents($a);
    $y = @file_get_contents($b);
    return $x !== false && $y !== false && $x === $y;
  }

  /**
   * Copy a stack's saved-version snapshot files from its old folder to the new
   * one, so the version rows still resolve after they move. The files stay
   * where they are.
   *
   * @return array version id => file_path to store (relative to the new folder)
   */
  private function carryVersionFiles(array $fromRow, $toDir)
  {
    $paths = [];
    $fromDir = is_string($fromRow['working_dir']) ? $fromRow['working_dir'] : null;
    $toDir = is_string($toDir) ? normalizePath($toDir) : null;
    if ($fromDir === null || $toDir === null || $toDir === '/') {
      return $paths;
    }
    $rows = $this->db->fetchAll(
      'SELECT id, file_path FROM compose_file_versions WHERE project_name = ?',
      [$fromRow['project_name']]
    );
    foreach ($rows as $v) {
      $src = resolveAgainst($v['file_path'], $fromDir);
      $name = basename($v['file_path']);
      if ($src === null || !pathIsWithin($src, $fromDir) || !is_file($src) || safePathComponent($name) === null) {
        continue;
      }
      $rel = '.versions/' . $name;
      $dest = $toDir . '/' . $rel;
      if (is_file($dest) && !self::sameBytes($src, $dest)) {
        $rel = '.versions/' . $v['id'] . '-' . $name;
        $dest = $toDir . '/' . $rel;
      }
      if (!is_dir($toDir . '/.versions') && !@mkdir($toDir . '/.versions', 0755, true)) {
        continue;
      }
      if (is_file($dest) || @copy($src, $dest)) {
        $paths[$v['id']] = $rel;
      }
    }
    return $paths;
  }

  /**
   * Move everything that hangs on the stack $from to the stack named $to.
   * The row $to must already exist (compose_file_versions has a foreign key
   * to it). Runs inside the caller's transaction.
   */
  private function moveStackReferences($from, $to, array $versionPaths)
  {
    $this->db->update(
      'schedules',
      ['target_id' => $to],
      "target_type = 'stack' AND target_id = ?",
      [$from]
    );

    $this->moveVersionFiles($to, $versionPaths);
    // Rows whose file could not be carried keep their path and still move.
    $this->db->update('compose_file_versions', ['project_name' => $to], 'project_name = ?', [$from]);

    foreach ($this->db->fetchAll('SELECT id FROM folders WHERE compose_project = ?', [$from]) as $folder) {
      $kept = $this->db->fetchOne('SELECT id FROM folders WHERE compose_project = ?', [$to]);
      if (!$kept) {
        $this->db->update('folders', ['compose_project' => $to, 'updated_at' => time()], 'id = ?', [$folder['id']]);
        continue;
      }
      $members = (int) $this->db->fetchValue('SELECT COUNT(*) FROM container_folders WHERE folder_id = ?', [$folder['id']]);
      if ($members === 0) {
        $this->db->delete('folders', 'id = ?', [$folder['id']]);
      } else {
        // Containers the user put there stay there, as an ordinary folder.
        $this->db->update('folders', ['compose_project' => null, 'updated_at' => time()], 'id = ?', [$folder['id']]);
      }
    }
  }

  /** Point carried version rows at their new relative path, under the stack $to. */
  private function moveVersionFiles($to, array $versionPaths)
  {
    foreach ($versionPaths as $id => $path) {
      $this->db->update('compose_file_versions', ['project_name' => $to, 'file_path' => $path], 'id = ?', [$id]);
    }
  }

  private function mergeStackRows(array $from, array $to, array $versionPaths)
  {
    $now = time();
    $updates = [];
    if ($to['imported_from'] !== 'compose_plugin') {
      // So the import prompt stays away once the copy row is gone.
      $updates['imported_from'] = 'compose_plugin';
    }
    if (empty($to['description']) && !empty($from['description'])) {
      $updates['description'] = $from['description'];
    }
    if (!$to['autostart'] && $from['autostart']) {
      $updates['autostart'] = 1;
    }
    if (!$to['autostart_force_recreate'] && $from['autostart_force_recreate']) {
      $updates['autostart_force_recreate'] = 1;
    }
    if (!empty($updates)) {
      $updates['updated_at'] = $now;
      $this->db->update('compose_stacks', $updates, 'project_name = ?', [$to['project_name']]);
    }

    $this->moveStackReferences($from['project_name'], $to['project_name'], $versionPaths);
    $this->db->delete('compose_stacks', 'project_name = ?', [$from['project_name']]);
  }

  private function renameStackRow(array $from, $newName, $sourceDir, array $versionPaths)
  {
    $now = time();
    if ($newName === $from['project_name']) {
      $this->db->update('compose_stacks', [
        'working_dir' => $sourceDir,
        'compose_file' => $sourceDir . '/' . basename((string) $from['compose_file']),
        'env_file' => null,
        'updated_at' => $now,
      ], 'project_name = ?', [$newName]);
      $this->moveVersionFiles($newName, $versionPaths);
      return;
    }
    $this->db->insert('compose_stacks', [
      'project_name' => $newName,
      'working_dir' => $sourceDir,
      'compose_file' => $sourceDir . '/' . basename((string) $from['compose_file']),
      'env_file' => null,
      'autostart' => $from['autostart'],
      'autostart_force_recreate' => $from['autostart_force_recreate'],
      'description' => $from['description'],
      'imported_from' => 'compose_plugin',
      'created_at' => $from['created_at'],
      'updated_at' => $now,
    ]);
    $this->moveStackReferences($from['project_name'], $newName, $versionPaths);
    $this->db->delete('compose_stacks', 'project_name = ?', [$from['project_name']]);
  }

  /**
   * Export all compose stack configs to a target directory
   */
  public function exportConfigs($exportDir = null)
  {
    if (!$exportDir) {
      $exportDir = COMPOSE_STACKS_DIR;
    }

    // Validate path is absolute and inside an allowed root. settings.php also
    // checks this at write time; this guards values stored before that existed.
    $exportDir = normalizePath($exportDir);
    if ($exportDir === null) {
      return ['success' => false, 'error' => 'Export directory must be an absolute path'];
    }
    if (!pathIsWithinAny($exportDir, EXPORT_ALLOWED_ROOTS)) {
      return [
        'success' => false,
        'error' => 'Export directory must be under ' . implode(' or ', EXPORT_ALLOWED_ROOTS),
      ];
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

      // project_name comes from the com.docker.compose.project label of a
      // running container, which anyone who can start a container can set.
      // A value such as "../../etc" would put these root-owned writes outside
      // the export directory. safePathComponent() and not safeProjectName():
      // a stack imported from compose.manager keeps its directory name, which
      // can contain a dot.
      if (safePathComponent($projectName) === null) {
        $errors[] = "Skipped a stack with an unsafe project name";
        continue;
      }
      $projectDir = $exportDir . '/' . $projectName;
      if (!pathIsWithin($projectDir, $exportDir)) {
        $errors[] = "Skipped a stack with an unsafe project name";
        continue;
      }

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
