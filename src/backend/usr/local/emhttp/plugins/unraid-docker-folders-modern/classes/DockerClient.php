<?php
/**
 * Unraid Docker Folders - Docker Client
 *
 * Wrapper for Docker Engine API via Unix socket
 *
 * @package UnraidDockerModern
 */

class DockerClient
{
  private $socketPath;
  private $apiVersion;

  public function __construct($socketPath = DOCKER_SOCKET, $apiVersion = DOCKER_API_VERSION)
  {
    $this->socketPath = $socketPath;
    $this->apiVersion = $apiVersion;
  }

  /**
   * List all containers
   *
   * @param bool $all Include stopped containers
   * @return array Array of container objects
   */
  public function listContainers($all = true)
  {
    $params = $all ? '?all=1' : '';
    $response = $this->request('GET', "/containers/json{$params}");

    if (!$response) {
      return [];
    }

    // Transform Docker API response to our format
    $containers = [];
    foreach ($response as $container) {
      $containers[] = $this->formatContainer($container);
    }

    return $containers;
  }

  /**
   * Get container details
   *
   * @param string $id Container ID or name
   * @return array|null Container object or null if not found
   */
  public function inspectContainer($id)
  {
    $response = $this->request('GET', "/containers/{$id}/json");

    if (!$response) {
      return null;
    }

    return $this->formatContainerDetail($response);
  }

  /**
   * Start a container
   *
   * @param string $id Container ID or name
   * @return bool Success
   */
  public function startContainer($id)
  {
    $response = $this->request('POST', "/containers/{$id}/start");
    return $response !== false;
  }

  /**
   * Stop a container
   *
   * @param string $id Container ID or name
   * @param int $timeout Seconds to wait before killing
   * @return bool Success
   */
  public function stopContainer($id, $timeout = 10)
  {
    $response = $this->request('POST', "/containers/{$id}/stop?t={$timeout}");
    return $response !== false;
  }

  /**
   * Restart a container
   *
   * @param string $id Container ID or name
   * @param int $timeout Seconds to wait before killing
   * @return bool Success
   */
  public function restartContainer($id, $timeout = 10)
  {
    $response = $this->request('POST', "/containers/{$id}/restart?t={$timeout}");
    return $response !== false;
  }

  /**
   * Remove a container
   *
   * @param string $id Container ID or name
   * @param bool $force Force removal
   * @return bool Success
   */
  public function removeContainer($id, $force = false)
  {
    $params = $force ? '?force=1' : '';
    $response = $this->request('DELETE', "/containers/{$id}{$params}");
    return $response !== false;
  }

  /**
   * Get container logs
   *
   * @param string $id Container ID or name
   * @param int $tail Number of lines from end
   * @return string Logs
   */
  public function getContainerLogs($id, $tail = 100)
  {
    $response = $this->request('GET', "/containers/{$id}/logs?stdout=1&stderr=1&tail={$tail}");
    return $response ?? '';
  }

  /**
   * Get one-shot container stats (CPU, memory, network, block I/O)
   *
   * @param string $id Container ID or name
   * @return array|null Raw stats or null on error
   */
  public function getContainerStats($id)
  {
    $response = $this->request('GET', "/containers/{$id}/stats?stream=0");
    return $response ?: null;
  }

  /**
   * Get image info
   *
   * @param string $imageId Image ID or name
   * @return array|null Image detail or null on error
   */
  public function getImageInfo($imageId)
  {
    $response = $this->request('GET', "/images/{$imageId}/json");
    return $response ?: null;
  }

  /**
   * Get container log file size
   *
   * @param string $fullId Full container ID (64 chars)
   * @return int Size in bytes (0 if not found)
   */
  public function getContainerLogSize($fullId)
  {
    $logPath = "/var/lib/docker/containers/{$fullId}/{$fullId}-json.log";
    if (file_exists($logPath)) {
      return (int) filesize($logPath);
    }
    return 0;
  }

  /**
   * Get formatted stats for a container
   *
   * Orchestrates calls to stats, inspect, and image endpoints,
   * then computes CPU %, memory %, and aggregates all metrics.
   *
   * @param string $id Container ID or name
   * @return array|null Formatted stats or null if container not running
   */
  public function formatStats($id)
  {
    $stats = $this->getContainerStats($id);
    if (!$stats) {
      return null;
    }

    // CPU % from precpu_stats vs cpu_stats delta
    $cpuPercent = 0.0;
    $cpuStats = $stats['cpu_stats'] ?? [];
    $preCpuStats = $stats['precpu_stats'] ?? [];

    $cpuDelta = ($cpuStats['cpu_usage']['total_usage'] ?? 0)
              - ($preCpuStats['cpu_usage']['total_usage'] ?? 0);
    $systemDelta = ($cpuStats['system_cpu_usage'] ?? 0)
                 - ($preCpuStats['system_cpu_usage'] ?? 0);
    $onlineCpus = $cpuStats['online_cpus'] ?? 1;

    if ($systemDelta > 0 && $cpuDelta >= 0) {
      $cpuPercent = round(($cpuDelta / $systemDelta) * $onlineCpus * 100, 2);
    }

    // Memory
    $memStats = $stats['memory_stats'] ?? [];
    $memoryUsage = $memStats['usage'] ?? 0;
    $memoryLimit = $memStats['limit'] ?? 1;
    $memoryPercent = $memoryLimit > 0 ? round(($memoryUsage / $memoryLimit) * 100, 2) : 0;

    // Block I/O
    $blockRead = 0;
    $blockWrite = 0;
    $blkioStats = $stats['blkio_stats']['io_service_bytes_recursive'] ?? [];
    foreach ($blkioStats as $entry) {
      $op = strtolower($entry['op'] ?? '');
      if ($op === 'read') {
        $blockRead += $entry['value'] ?? 0;
      } elseif ($op === 'write') {
        $blockWrite += $entry['value'] ?? 0;
      }
    }

    // Network
    $netRx = 0;
    $netTx = 0;
    $networks = $stats['networks'] ?? [];
    foreach ($networks as $iface) {
      $netRx += $iface['rx_bytes'] ?? 0;
      $netTx += $iface['tx_bytes'] ?? 0;
    }

    // PIDs
    $pids = $stats['pids_stats']['current'] ?? 0;

    // Inspect for restart count and startedAt
    $inspect = $this->inspectContainer($id);
    $restartCount = $inspect['restartCount'] ?? 0;
    $startedAt = $inspect['state']['startedAt'] ?? '';

    // Image size
    $imageSize = 0;
    $imageId = $inspect['imageId'] ?? '';
    if ($imageId) {
      $imageInfo = $this->getImageInfo($imageId);
      $imageSize = $imageInfo['Size'] ?? 0;
    }

    // Log size (need full 64-char container ID)
    $fullId = $stats['id'] ?? $id;
    $logSize = $this->getContainerLogSize($fullId);

    return [
      'cpuPercent' => $cpuPercent,
      'memoryUsage' => $memoryUsage,
      'memoryLimit' => $memoryLimit,
      'memoryPercent' => $memoryPercent,
      'blockRead' => $blockRead,
      'blockWrite' => $blockWrite,
      'netRx' => $netRx,
      'netTx' => $netTx,
      'pids' => $pids,
      'restartCount' => $restartCount,
      'startedAt' => $startedAt,
      'imageSize' => $imageSize,
      'logSize' => $logSize,
    ];
  }

  /**
   * Execute multiple Docker API requests in parallel via curl_multi
   *
   * @param array $requests Associative array of ['key' => '/api/path', ...]
   * @return array Associative array of ['key' => decoded_json | null, ...]
   */
  private function requestMulti($requests)
  {
    if (empty($requests)) {
      return [];
    }

    $mh = curl_multi_init();
    $handles = [];

    foreach ($requests as $key => $path) {
      $url = "http://localhost/{$this->apiVersion}{$path}";
      $ch = curl_init();
      curl_setopt($ch, CURLOPT_UNIX_SOCKET_PATH, $this->socketPath);
      curl_setopt($ch, CURLOPT_URL, $url);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
      curl_setopt($ch, CURLOPT_HEADER, false);
      curl_setopt($ch, CURLOPT_TIMEOUT, 5);
      curl_multi_add_handle($mh, $ch);
      $handles[$key] = $ch;
    }

    // Execute all handles
    $running = null;
    do {
      curl_multi_exec($mh, $running);
      if ($running > 0) {
        curl_multi_select($mh);
      }
    } while ($running > 0);

    // Collect results
    $results = [];
    foreach ($handles as $key => $ch) {
      $response = curl_multi_getcontent($ch);
      $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
      $error = curl_error($ch);

      if ($error || $httpCode < 200 || $httpCode >= 300) {
        $results[$key] = null;
      } else {
        $decoded = json_decode($response, true);
        $results[$key] = ($decoded === null && json_last_error() !== JSON_ERROR_NONE) ? null : $decoded;
      }

      curl_multi_remove_handle($mh, $ch);
      curl_close($ch);
    }

    curl_multi_close($mh);
    return $results;
  }

  /**
   * Fetch stats for multiple containers in parallel
   *
   * Runs 3 phases of parallel requests instead of sequential per-container calls:
   *   Phase 1: All container stats in parallel
   *   Phase 2: All container inspects in parallel
   *   Phase 3: All unique image inspects in parallel (deduped)
   *
   * @param array $ids Array of container IDs
   * @return array Associative array of ['id' => formattedStats | null, ...]
   */
  public function fetchBatchStats($ids)
  {
    if (empty($ids)) {
      return [];
    }

    // Phase 1: Fetch all container stats in parallel
    $statsRequests = [];
    foreach ($ids as $id) {
      $statsRequests[$id] = "/containers/{$id}/stats?stream=0";
    }
    $statsResults = $this->requestMulti($statsRequests);

    // Phase 2: Fetch all container inspects in parallel
    $inspectRequests = [];
    foreach ($ids as $id) {
      if ($statsResults[$id] !== null) {
        $inspectRequests[$id] = "/containers/{$id}/json";
      }
    }
    $inspectResults = $this->requestMulti($inspectRequests);

    // Phase 3: Collect unique image IDs and fetch image info in parallel
    $imageMap = []; // imageId => [containerId, ...]
    foreach ($inspectResults as $id => $inspect) {
      if ($inspect === null) continue;
      $imageId = $inspect['Image'] ?? '';
      if ($imageId) {
        $imageMap[$imageId][] = $id;
      }
    }

    $imageRequests = [];
    foreach (array_keys($imageMap) as $imageId) {
      $imageRequests[$imageId] = "/images/{$imageId}/json";
    }
    $imageResults = $this->requestMulti($imageRequests);

    // Phase 4: Assemble formatted stats for each container
    $output = [];
    foreach ($ids as $id) {
      $stats = $statsResults[$id] ?? null;
      if (!$stats) {
        $output[$id] = null;
        continue;
      }

      // CPU %
      $cpuPercent = 0.0;
      $cpuStats = $stats['cpu_stats'] ?? [];
      $preCpuStats = $stats['precpu_stats'] ?? [];
      $cpuDelta = ($cpuStats['cpu_usage']['total_usage'] ?? 0)
                - ($preCpuStats['cpu_usage']['total_usage'] ?? 0);
      $systemDelta = ($cpuStats['system_cpu_usage'] ?? 0)
                   - ($preCpuStats['system_cpu_usage'] ?? 0);
      $onlineCpus = $cpuStats['online_cpus'] ?? 1;
      if ($systemDelta > 0 && $cpuDelta >= 0) {
        $cpuPercent = round(($cpuDelta / $systemDelta) * $onlineCpus * 100, 2);
      }

      // Memory
      $memStats = $stats['memory_stats'] ?? [];
      $memoryUsage = $memStats['usage'] ?? 0;
      $memoryLimit = $memStats['limit'] ?? 1;
      $memoryPercent = $memoryLimit > 0 ? round(($memoryUsage / $memoryLimit) * 100, 2) : 0;

      // Block I/O
      $blockRead = 0;
      $blockWrite = 0;
      $blkioStats = $stats['blkio_stats']['io_service_bytes_recursive'] ?? [];
      foreach ($blkioStats as $entry) {
        $op = strtolower($entry['op'] ?? '');
        if ($op === 'read') {
          $blockRead += $entry['value'] ?? 0;
        } elseif ($op === 'write') {
          $blockWrite += $entry['value'] ?? 0;
        }
      }

      // Network
      $netRx = 0;
      $netTx = 0;
      $networks = $stats['networks'] ?? [];
      foreach ($networks as $iface) {
        $netRx += $iface['rx_bytes'] ?? 0;
        $netTx += $iface['tx_bytes'] ?? 0;
      }

      // PIDs
      $pids = $stats['pids_stats']['current'] ?? 0;

      // Inspect data
      $inspect = $inspectResults[$id] ?? null;
      $restartCount = $inspect['RestartCount'] ?? 0;
      $startedAt = $inspect['State']['StartedAt'] ?? '';

      // Image size (deduped)
      $imageSize = 0;
      $imageId = $inspect['Image'] ?? '';
      if ($imageId && isset($imageResults[$imageId])) {
        $imageSize = $imageResults[$imageId]['Size'] ?? 0;
      }

      // Log size
      $fullId = $stats['id'] ?? $id;
      $logSize = $this->getContainerLogSize($fullId);

      $output[$id] = [
        'cpuPercent' => $cpuPercent,
        'memoryUsage' => $memoryUsage,
        'memoryLimit' => $memoryLimit,
        'memoryPercent' => $memoryPercent,
        'blockRead' => $blockRead,
        'blockWrite' => $blockWrite,
        'netRx' => $netRx,
        'netTx' => $netTx,
        'pids' => $pids,
        'restartCount' => $restartCount,
        'startedAt' => $startedAt,
        'imageSize' => $imageSize,
        'logSize' => $logSize,
      ];
    }

    return $output;
  }

  /**
   * Get local image digest from RepoDigests
   *
   * @param string $imageRef Image name or ID
   * @return string|null Digest string or null
   */
  public function getImageDigest($imageRef)
  {
    $info = $this->getImageInfo($imageRef);
    if (!$info) return null;

    $digests = $info['RepoDigests'] ?? [];
    return !empty($digests) ? $digests[0] : null;
  }

  /**
   * Get remote image digest via Docker distribution API
   *
   * Uses the Docker daemon's /distribution endpoint which leverages
   * the daemon's configured registry credentials.
   *
   * @param string $imageName Full image reference (e.g. linuxserver/plex:latest)
   * @return string|null Remote digest or null on error
   */
  public function getRemoteImageDigest($imageName)
  {
    $response = $this->request('GET', "/distribution/{$imageName}/json", null, 15);
    if (!$response) return null;

    return $response['Descriptor']['digest'] ?? null;
  }

  /**
   * Check if an image has an update available
   *
   * @param string $imageName Image reference (e.g. linuxserver/plex:latest)
   * @param string $localImageId Local image ID for digest lookup
   * @return array Result with update_available, local_digest, remote_digest, error
   */
  public function checkImageUpdate($imageName, $localImageId)
  {
    $result = [
      'update_available' => false,
      'local_digest' => null,
      'remote_digest' => null,
      'error' => null,
    ];

    // Get local digest
    $localDigest = $this->getImageDigest($localImageId);
    $result['local_digest'] = $localDigest;

    // Get remote digest
    $remoteDigest = $this->getRemoteImageDigest($imageName);
    if ($remoteDigest === null) {
      $result['error'] = 'Failed to fetch remote digest';
      return $result;
    }
    $result['remote_digest'] = $remoteDigest;

    // Compare: local RepoDigest format is "name@sha256:abc...", remote is just "sha256:abc..."
    if ($localDigest && $remoteDigest) {
      $localHash = strpos($localDigest, '@') !== false
        ? substr($localDigest, strpos($localDigest, '@') + 1)
        : $localDigest;
      $result['update_available'] = ($localHash !== $remoteDigest);
    }

    return $result;
  }

  /**
   * Pull a Docker image with progress callback
   *
   * @param string $imageName Image to pull (e.g. linuxserver/plex:latest)
   * @param callable $onProgress Callback receiving JSON progress chunks
   * @return bool True on success
   */
  public function pullImage($imageName, callable $onProgress)
  {
    if (!file_exists($this->socketPath)) {
      return false;
    }

    // Split name:tag
    $parts = explode(':', $imageName, 2);
    $fromImage = $parts[0];
    $tag = $parts[1] ?? 'latest';

    $url = "http://localhost/{$this->apiVersion}/images/create?fromImage=" . urlencode($fromImage) . "&tag=" . urlencode($tag);

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_UNIX_SOCKET_PATH, $this->socketPath);
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_HEADER, false);
    curl_setopt($ch, CURLOPT_TIMEOUT, 600); // 10 minute timeout

    // Stream response chunks to the callback
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use ($onProgress) {
      // Docker sends newline-delimited JSON
      $lines = explode("\n", $data);
      foreach ($lines as $line) {
        $line = trim($line);
        if (empty($line)) continue;
        $decoded = json_decode($line, true);
        if ($decoded !== null) {
          $onProgress($decoded);
        }
      }
      return strlen($data);
    });

    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($error) {
      error_log("Docker pull error: {$error}");
      return false;
    }

    return $httpCode >= 200 && $httpCode < 300;
  }

  /**
   * Format container from list endpoint
   *
   * @param array $container Raw container data
   * @return array Formatted container
   */
  private function formatContainer($container)
  {
    $labels = $container['Labels'] ?? [];
    return [
      'id' => $container['Id'],
      'name' => ltrim($container['Names'][0] ?? '', '/'),
      'image' => $container['Image'],
      'imageId' => $container['ImageID'] ?? '',
      'command' => $container['Command'] ?? '',
      'created' => $container['Created'],
      'state' => $container['State'],
      'status' => $container['Status'],
      'ports' => $container['Ports'] ?? [],
      'labels' => $labels,
      'networkMode' => $container['HostConfig']['NetworkMode'] ?? 'bridge',
      'mounts' => $container['Mounts'] ?? [],
      'networkSettings' => $container['NetworkSettings']['Networks'] ?? (object)[],
      'icon' => $labels['net.unraid.docker.icon'] ?? null,
      'managed' => $labels['net.unraid.docker.managed'] ?? null,
      'webui' => $labels['net.unraid.docker.webui'] ?? null,
    ];
  }

  /**
   * Format detailed container info
   *
   * @param array $container Raw container detail
   * @return array Formatted container
   */
  private function formatContainerDetail($container)
  {
    return [
      'id' => $container['Id'],
      'name' => ltrim($container['Name'] ?? '', '/'),
      'image' => $container['Config']['Image'] ?? '',
      'imageId' => $container['Image'] ?? '',
      'created' => $container['Created'],
      'path' => $container['Path'] ?? '',
      'args' => $container['Args'] ?? [],
      'state' => [
        'status' => $container['State']['Status'] ?? 'unknown',
        'running' => $container['State']['Running'] ?? false,
        'paused' => $container['State']['Paused'] ?? false,
        'restarting' => $container['State']['Restarting'] ?? false,
        'pid' => $container['State']['Pid'] ?? 0,
        'exitCode' => $container['State']['ExitCode'] ?? 0,
        'startedAt' => $container['State']['StartedAt'] ?? '',
        'finishedAt' => $container['State']['FinishedAt'] ?? '',
      ],
      'restartCount' => $container['RestartCount'] ?? 0,
      'platform' => $container['Platform'] ?? 'linux',
      'mounts' => $container['Mounts'] ?? [],
      'config' => [
        'hostname' => $container['Config']['Hostname'] ?? '',
        'env' => $container['Config']['Env'] ?? [],
        'labels' => $container['Config']['Labels'] ?? [],
      ],
      'networkSettings' => [
        'networks' => $container['NetworkSettings']['Networks'] ?? [],
        'ports' => $container['NetworkSettings']['Ports'] ?? [],
        'ipAddress' => $container['NetworkSettings']['IPAddress'] ?? '',
      ],
    ];
  }

  /**
   * Make HTTP request to Docker API via Unix socket
   *
   * @param string $method HTTP method
   * @param string $path API path
   * @param array|null $data Request body
   * @return mixed Response data or false on error
   */
  private function request($method, $path, $data = null, $timeout = 5)
  {
    if (!file_exists($this->socketPath)) {
      error_log("Docker socket not found: {$this->socketPath}");
      return false;
    }

    $url = "http://localhost/{$this->apiVersion}{$path}";

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_UNIX_SOCKET_PATH, $this->socketPath);
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, false);
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);

    if ($data !== null) {
      $json = json_encode($data);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $json);
      curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json', 'Content-Length: ' . strlen($json)]);
    }

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($error) {
      error_log("Docker API error: {$error}");
      return false;
    }

    // 204 No Content is success for some operations (start, stop, etc.)
    if ($httpCode === 204) {
      return true;
    }

    // 304 Not Modified
    if ($httpCode === 304) {
      return true;
    }

    // 404 Not Found
    if ($httpCode === 404) {
      return false;
    }

    // Other non-200 codes
    if ($httpCode < 200 || $httpCode >= 300) {
      error_log("Docker API HTTP {$httpCode}: {$response}");
      return false;
    }

    // Decode JSON response
    $decoded = json_decode($response, true);
    if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
      error_log('Docker API JSON decode error: ' . json_last_error_msg());
      return false;
    }

    return $decoded;
  }
}
