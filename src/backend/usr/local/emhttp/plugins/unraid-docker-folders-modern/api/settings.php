<?php
/**
 * Unraid Docker Folders - Settings API
 *
 * Endpoints for managing plugin settings
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';
require_once dirname(__DIR__) . '/classes/ComposeManager.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'];

requireAuth();

try {
  switch ($method) {
    case 'GET':
      handleGet();
      break;

    case 'POST':
      handlePost();
      break;

    case 'OPTIONS':
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Settings API error: ' . $e->getMessage());
  errorResponse('Internal server error', 500);
}

function handleGet()
{
  // Polled by the settings page while the GraphQL backend installs or is
  // removed. Read only.
  if (($_GET['action'] ?? '') === 'backend-status') {
    $apiVersion = dfmUnraidApiVersion();
    jsonResponse([
      'mode' => dfmBackendMode(),
      'plugin' => dfmReadJsonFile(DFM_API_PLUGIN_STATE_FILE),
      'rollback' => dfmReadJsonFile(DFM_BACKEND_ROLLBACK_MARKER),
      'apiVersion' => $apiVersion,
      'apiSupported' => dfmApiVersionSupported($apiVersion, dfmApiCompatRange()),
    ]);
  }

  $db = Database::getInstance();
  $rows = $db->fetchAll('SELECT key, value FROM settings');

  $settings = [];
  foreach ($rows as $row) {
    $settings[$row['key']] = $row['value'];
  }

  // Synthetic, read-only: the zone PHP is actually running in (see
  // detectServerTimezone() in config.php). Not in the POST allowlist, so it
  // cannot be overwritten by a client.
  $settings['server_timezone'] = date_default_timezone_get();

  jsonResponse(['settings' => $settings]);
}

function handlePost()
{
  $db = Database::getInstance();
  $data = getRequestData();

  // Handle clear_log action
  if (isset($data['action']) && $data['action'] === 'clear_log') {
    $logPath = CONFIG_DIR . '/update-check.log';
    if (file_exists($logPath)) {
      file_put_contents($logPath, '');
    }
    jsonResponse(['success' => true]);
    return;
  }

  if (!$data || !isset($data['key']) || !isset($data['value'])) {
    errorResponse('Missing key or value', 400);
  }

  $key = $data['key'];
  $value = $data['value'];
  $now = time();

  // Validate key against allowlist
  $allowedKeys = [
    'distinguish_healthy', 'show_stats', 'replace_docker_section',
    'show_legacy_containers', 'show_legacy_buttons',
    'show_folder_ports', 'show_inline_logs', 'enable_adopt',
    'enable_security_advisor',
    'enable_update_checks',
    'update_check_schedule', 'notify_on_updates', 'update_check_exclude',
    'post_pull_action',
    'update_concurrency',
    'log_refresh_interval',
    'stats_refresh_interval',
    'compose_export_dir',
    'compose_auto_install',
    'confirm_stack_down', 'confirm_recompose',
    'backup_destination',
    'default_retention_count',
    'sort_mode', 'sort_folders',
    'backend_mode',
    'memory_calculation',
    'memory_percent_basis',
  ];
  if (!in_array($key, $allowedKeys, true)) {
    errorResponse('Invalid settings key', 400);
  }

  // backend_mode picks which backend the Vue app talks to. Anything other
  // than the two known values would leave the frontend with no transport, so
  // reject rather than store it.
  if ($key === 'backend_mode' && !in_array($value, BACKEND_MODES, true)) {
    errorResponse('Invalid backend mode', 400);
  }

  // These checkboxes store '0' or '1' only. For compose_auto_install a JSON 1
  // or true would be stored as '1' but fail the === '1' test below, which
  // deletes the flash copy of a setting that then reads as on. For the
  // confirm settings, the settings page reads only '1' as on and the Vue app
  // anything but '0', so any other value would show the two disagreeing.
  $checkboxKeys = ['compose_auto_install', 'confirm_stack_down', 'confirm_recompose'];
  if (in_array($key, $checkboxKeys, true) && !in_array($value, ['0', '1'], true)) {
    errorResponse($key . ' must be "0" or "1"', 400);
  }

  // Validate sort_mode against the known set of modes.
  if ($key === 'sort_mode' && !in_array($value, SORT_MODES, true)) {
    errorResponse('Invalid sort_mode', 400);
  }

  if ($key === 'memory_calculation' && !in_array($value, MEMORY_CALCULATION_MODES, true)) {
    errorResponse('Invalid memory_calculation', 400);
  }

  if ($key === 'memory_percent_basis' && !in_array($value, MEMORY_PERCENT_BASES, true)) {
    errorResponse('Invalid memory_percent_basis', 400);
  }

  // Validate value length
  if (is_string($value) && strlen($value) > 10000) {
    errorResponse('Value too long', 400);
  }

  // Validate path settings before they are stored. These are the top of a chain
  // that ends in mkdir/write as root: compose_export_dir reaches
  // ComposeManager::exportConfigs and backup_destination reaches
  // BackupManager::resolveDestination. An empty value means "use the default".
  $pathSettingRoots = [
    'compose_export_dir' => EXPORT_ALLOWED_ROOTS,
    'backup_destination' => BACKUP_ALLOWED_ROOTS,
  ];
  if (isset($pathSettingRoots[$key]) && is_string($value) && trim($value) !== '') {
    $normalizedSetting = normalizePath(trim($value));
    if ($normalizedSetting === null) {
      errorResponse('Path must be absolute', 400);
    }
    if (!pathIsWithinAny($normalizedSetting, $pathSettingRoots[$key])) {
      errorResponse(
        'Path must be under ' . implode(' or ', $pathSettingRoots[$key]),
        400
      );
    }
    $value = $normalizedSetting;
  }

  // Clamp bounded numeric settings — the UI <select> is not the only writer.
  // The plugin clamps its stats stream to 1s..300s, so a stored
  // stats_refresh_interval outside that would not take effect.
  $integerRanges = [
    'update_concurrency' => [1, 5],
    'stats_refresh_interval' => [1, 300],
  ];
  if (isset($integerRanges[$key])) {
    [$min, $max] = $integerRanges[$key];
    $n = (int) $value;
    if ($n < $min || $n > $max) {
      errorResponse("{$key} must be between {$min} and {$max}", 400);
    }
    $value = (string) $n;
  }

  // Switching backends installs or removes the GraphQL backend in the Unraid
  // API, which restarts the API, so the script runs detached. GraphQL is not
  // stored here: the script stores it once the backend answers, so a failed
  // install leaves the page on PHP. PHP is stored at once, before the removal.
  if ($key === 'backend_mode') {
    // The run id tags the state file, so the page waits for this run and not
    // for a boot or watchdog run that writes the same file. The rollback
    // marker stays until the install succeeds; the script deletes it then.
    $run = bin2hex(random_bytes(8));
    if ($value === 'graphql') {
      // The page disables the option on an untested API, but a POST can skip
      // the page. api-plugin.sh refuses too; this answers before it starts.
      $versionReason = dfmApiVersionReason(dfmUnraidApiVersion(), dfmApiCompatRange());
      if ($versionReason !== '') {
        errorResponse($versionReason, 409);
      }
      dfmLaunchApiPlugin('install', $run);
      jsonResponse(['success' => true, 'key' => $key, 'value' => dfmBackendMode(), 'pending' => 'install', 'run' => $run]);
    }
    dfmWriteBackendMode($db, 'php');
    dfmLaunchApiPlugin('remove', $run);
    jsonResponse(['success' => true, 'key' => $key, 'value' => 'php', 'pending' => 'remove', 'run' => $run]);
  }

  dfmUpsertSetting($db, $key, $value);

  // DockerClient caches this one in /tmp. Drop the copy so it applies now.
  if ($key === 'memory_calculation') {
    @unlink(DockerClient::MEMORY_MODE_CACHE_PATH);
  }

  // Keep the flash copy of the compose binary in step with the option: take a
  // copy when it is switched on and compose is already installed, drop it
  // when it is switched off. With compose not installed yet, the install or
  // the next boot takes the copy.
  if ($key === 'compose_auto_install') {
    $composeManager = new ComposeManager();
    if ($value === '0') {
      $composeManager->removeCachedComposeBinary();
    } elseif (is_file(ComposeManager::COMPOSE_BINARY_PATH)) {
      $cached = $composeManager->cacheComposeBinary();
      if (!$composeManager->isAutoInstallEnabled()) {
        // Switched off while this request copied. The off request found no
        // finished copy to delete, so delete it here.
        $composeManager->removeCachedComposeBinary();
      } elseif (!$cached['success']) {
        errorResponse('Saved, but ' . $cached['error'], 500);
      }
    }
  }

  // When update_check_schedule changes, update or remove the cron file
  if ($key === 'update_check_schedule') {
    CronManager::updateSchedule($value);
  }

  // When update checks are disabled entirely, also remove the cron file
  if ($key === 'enable_update_checks' && $value === '0') {
    CronManager::removeSchedule();
    // Reset schedule setting to disabled
    $existing = $db->fetchOne('SELECT key FROM settings WHERE key = ?', ['update_check_schedule']);
    if ($existing) {
      $db->update('settings', ['value' => 'disabled', 'updated_at' => $now], 'key = ?', ['update_check_schedule']);
    }
  }

  // When update checks are re-enabled, rewrite the cron from the stored
  // schedule so the user doesn't have to reselect it after a toggle.
  if ($key === 'enable_update_checks' && $value === '1') {
    $scheduleRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'update_check_schedule'");
    $schedule = ($scheduleRow && $scheduleRow['value'] !== 'disabled') ? $scheduleRow['value'] : 'daily';
    CronManager::updateSchedule($schedule);
    $existing = $db->fetchOne('SELECT key FROM settings WHERE key = ?', ['update_check_schedule']);
    if ($existing) {
      $db->update('settings', ['value' => $schedule, 'updated_at' => $now], 'key = ?', ['update_check_schedule']);
    } else {
      $db->insert('settings', ['key' => 'update_check_schedule', 'value' => $schedule, 'updated_at' => $now]);
    }
  }

  jsonResponse(['success' => true, 'key' => $key, 'value' => $value]);
}
