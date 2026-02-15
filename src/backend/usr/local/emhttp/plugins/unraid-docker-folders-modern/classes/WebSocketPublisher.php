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
  /**
   * Publish an event to nchan
   *
   * @param string $entity  Entity type ('container' or 'folder')
   * @param string $action  Action performed (e.g. 'start', 'stop', 'create', 'delete')
   * @param mixed  $data    Associated data (container info, folder info, etc.)
   */
  public static function publish($entity, $action, $data = null)
  {
    $event = json_encode([
      'type' => 'event',
      'entity' => $entity,
      'action' => $action,
      'data' => $data,
      'timestamp' => time(),
    ]);

    $ch = curl_init(NCHAN_PUB_URL);
    curl_setopt_array($ch, [
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
