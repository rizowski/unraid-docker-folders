<?php
/**
 * Unraid Docker Folders - WebSocket Publisher
 *
 * Publishes events to nchan for real-time frontend updates.
 * Fire-and-forget: failures are logged but never block the API response.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';

class WebSocketPublisher
{
  const PUBLISH_PAUSED_FILE = '/tmp/publishPaused';

  /**
   * Publish an event to nchan
   *
   * @param string $entity  Entity type ('container' or 'folder')
   * @param string $action  Action performed (e.g. 'start', 'stop', 'create', 'delete')
   * @param mixed  $data    Associated data (container info, folder info, etc.)
   */
  public static function publish($entity, $action, $data = null)
  {
    // Unraid creates this file while it restarts nginx after nchan runs out
    // of shared memory, and its own publisher (dynamix/include/publish.php)
    // sends nothing while it exists. Sending anyway would hit a socket that
    // is down on purpose and log one failure per change.
    if (is_file(self::PUBLISH_PAUSED_FILE)) {
      return;
    }

    $event = json_encode([
      'type' => 'event',
      'entity' => $entity,
      'action' => $action,
      'data' => $data,
      'timestamp' => time(),
    ]);

    $ch = curl_init(NCHAN_PUB_URL);
    curl_setopt_array($ch, [
      // nchan's publisher listens on a Unix socket. See NCHAN_SOCKET_PATH.
      CURLOPT_UNIX_SOCKET_PATH => NCHAN_SOCKET_PATH,
      CURLOPT_POST => true,
      CURLOPT_POSTFIELDS => $event,
      CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_TIMEOUT => 2,
      CURLOPT_CONNECTTIMEOUT => 1,
    ]);

    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($result === false || $httpCode >= 400) {
      error_log('WebSocketPublisher: Failed to publish event - ' . curl_error($ch) . ' (HTTP ' . $httpCode . ')');
    }

    curl_close($ch);
  }
}
