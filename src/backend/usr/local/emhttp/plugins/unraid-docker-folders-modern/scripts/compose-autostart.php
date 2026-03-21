<?php
/**
 * Compose Autostart Script
 *
 * Called by event/started hook when Docker starts.
 * Starts all compose stacks with autostart enabled.
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/ComposeManager.php';

$log = function ($msg) {
  $line = '[' . date('Y-m-d H:i:s') . '] compose-autostart: ' . $msg;
  echo $line . "\n";
  error_log($line);
};

$log('Starting compose autostart check');

try {
  $manager = new ComposeManager();

  if (!$manager->isComposeAvailable()) {
    $log('docker compose not available, skipping');
    exit(0);
  }

  $results = $manager->startAutostartStacks();

  if (empty($results)) {
    $log('No stacks configured for autostart');
  } else {
    foreach ($results as $project => $result) {
      $status = $result['success'] ? 'OK' : 'FAILED';
      $log("$project: $status");
      if (!$result['success'] && $result['error']) {
        $log("  Error: " . $result['error']);
      }
    }
  }

  $log('Compose autostart complete');
} catch (Exception $e) {
  $log('Fatal error: ' . $e->getMessage());
  exit(1);
}
