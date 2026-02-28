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
  private $lastError = '';

  public function __construct($socketPath = DOCKER_SOCKET, $apiVersion = DOCKER_API_VERSION)
  {
    $this->socketPath = $socketPath;
    $this->apiVersion = $apiVersion;
  }

  /**
   * Get the error message from the last failed request
   *
   * @return string
   */
  public function getLastError()
  {
    return $this->lastError;
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

    $cpu = $this->calculateCpuPercent($stats);
    $mem = $this->calculateMemoryStats($stats);
    $blockIO = $this->calculateBlockIO($stats);
    $netIO = $this->calculateNetworkIO($stats);
    $pids = $this->calculatePids($stats);

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
      'cpuPercent' => $cpu,
      'memoryUsage' => $mem['usage'],
      'memoryLimit' => $mem['limit'],
      'memoryPercent' => $mem['percent'],
      'blockRead' => $blockIO['read'],
      'blockWrite' => $blockIO['write'],
      'netRx' => $netIO['rx'],
      'netTx' => $netIO['tx'],
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

      $cpu = $this->calculateCpuPercent($stats);
      $mem = $this->calculateMemoryStats($stats);
      $blockIO = $this->calculateBlockIO($stats);
      $netIO = $this->calculateNetworkIO($stats);
      $pids = $this->calculatePids($stats);

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
        'cpuPercent' => $cpu,
        'memoryUsage' => $mem['usage'],
        'memoryLimit' => $mem['limit'],
        'memoryPercent' => $mem['percent'],
        'blockRead' => $blockIO['read'],
        'blockWrite' => $blockIO['write'],
        'netRx' => $netIO['rx'],
        'netTx' => $netIO['tx'],
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
   * Get raw container inspect data (full Docker API response)
   *
   * @param string $id Container ID or name
   * @return array|null Full inspect response or null if not found
   */
  public function inspectContainerRaw($id)
  {
    return $this->request('GET', "/containers/{$id}/json") ?: null;
  }

  /**
   * Rename a container
   *
   * @param string $id Container ID or name
   * @param string $newName New name for the container
   * @return bool Success
   */
  public function renameContainer($id, $newName)
  {
    $response = $this->request('POST', "/containers/{$id}/rename?name=" . urlencode($newName));
    return $response !== false;
  }

  /**
   * Create a container from config
   *
   * @param string $name Container name
   * @param array $config Container create body (Config + HostConfig + NetworkingConfig)
   * @return string|false New container ID or false on failure
   */
  public function createContainer($name, $config)
  {
    $response = $this->request('POST', "/containers/create?name=" . urlencode($name), $config, 30);
    if ($response && isset($response['Id'])) {
      return $response['Id'];
    }
    return false;
  }

  /**
   * Recreate a container with its current configuration but the latest image
   *
   * Safely: inspect → stop → rename → create → start → remove old
   * On failure: clean up new container, rename old back, restart if needed
   *
   * @param string $id Container ID or name
   * @return array ['success' => bool, 'newId' => string|null, 'error' => string|null]
   */
  public function recreateContainer($id)
  {
    $result = ['success' => false, 'newId' => null, 'error' => null];

    // 1. Inspect the existing container
    $inspect = $this->inspectContainerRaw($id);
    if (!$inspect) {
      $result['error'] = "Container {$id} not found";
      return $result;
    }

    $containerName = ltrim($inspect['Name'] ?? '', '/');
    $wasRunning = ($inspect['State']['Running'] ?? false) === true;
    $oldId = $inspect['Id'];
    $tempName = $containerName . '-recreating-' . time();
    $newId = null;

    // 2. Build create body from inspect data
    $config = $inspect['Config'] ?? [];

    // Remove read-only fields that shouldn't be in create body
    unset($config['Hostname']); // Let Docker assign based on container name
    // Keep Image, Env, Cmd, Labels, ExposedPorts, Volumes, etc.

    $createBody = $config;
    $createBody['HostConfig'] = $inspect['HostConfig'] ?? [];

    // Remove read-only HostConfig fields
    unset($createBody['HostConfig']['ContainerIDFile']);

    // Build NetworkingConfig from existing networks
    $networks = $inspect['NetworkSettings']['Networks'] ?? [];
    if (!empty($networks)) {
      $endpointsConfig = [];
      foreach ($networks as $netName => $netConfig) {
        // Only keep user-configurable fields, not dynamic ones
        $endpointsConfig[$netName] = [
          'IPAMConfig' => $netConfig['IPAMConfig'] ?? null,
          'Aliases' => $netConfig['Aliases'] ?? null,
          'Links' => $netConfig['Links'] ?? null,
          'DriverOpts' => $netConfig['DriverOpts'] ?? null,
        ];
      }
      $createBody['NetworkingConfig'] = ['EndpointsConfig' => $endpointsConfig];
    }

    try {
      // 3. Stop container if running
      if ($wasRunning) {
        if (!$this->stopContainer($oldId, 30)) {
          $result['error'] = "Failed to stop container {$containerName}: " . $this->lastError;
          return $result;
        }
      }

      // 4. Rename old container
      if (!$this->renameContainer($oldId, $tempName)) {
        // Try to restart if it was running
        if ($wasRunning) {
          $this->startContainer($oldId);
        }
        $result['error'] = "Failed to rename container {$containerName}: " . $this->lastError;
        return $result;
      }

      // 5. Create new container with original name
      $newId = $this->createContainer($containerName, $createBody);
      if (!$newId) {
        $createError = $this->lastError;
        // Rollback: rename old container back
        $this->renameContainer($oldId, $containerName);
        if ($wasRunning) {
          $this->startContainer($oldId);
        }
        $result['error'] = "Failed to create new container {$containerName}: {$createError}";
        return $result;
      }

      // 6. Start new container if old was running
      if ($wasRunning) {
        if (!$this->startContainer($newId)) {
          $startError = $this->lastError;
          // Rollback: remove new, rename old back, restart
          $this->removeContainer($newId, true);
          $this->renameContainer($oldId, $containerName);
          $this->startContainer($oldId);
          $result['error'] = "Failed to start new container {$containerName}: {$startError}";
          return $result;
        }
      }

      // 7. Remove old container
      $this->removeContainer($oldId, true);

      $result['success'] = true;
      $result['newId'] = $newId;
      return $result;

    } catch (\Throwable $e) {
      // Emergency rollback
      if ($newId) {
        $this->removeContainer($newId, true);
      }
      // Try to rename old container back
      $this->renameContainer($oldId, $containerName);
      if ($wasRunning) {
        $this->startContainer($oldId);
      }
      $result['error'] = $e->getMessage();
      return $result;
    }
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
   * Calculate CPU usage percentage from stats delta
   *
   * @param array $stats Raw Docker stats
   * @return float CPU usage percentage
   */
  private function calculateCpuPercent($stats)
  {
    $cpuStats = $stats['cpu_stats'] ?? [];
    $preCpuStats = $stats['precpu_stats'] ?? [];

    $cpuDelta = ($cpuStats['cpu_usage']['total_usage'] ?? 0)
              - ($preCpuStats['cpu_usage']['total_usage'] ?? 0);
    $systemDelta = ($cpuStats['system_cpu_usage'] ?? 0)
                 - ($preCpuStats['system_cpu_usage'] ?? 0);
    $onlineCpus = $cpuStats['online_cpus'] ?? 1;

    if ($systemDelta > 0 && $cpuDelta >= 0) {
      return round(($cpuDelta / $systemDelta) * $onlineCpus * 100, 2);
    }

    return 0.0;
  }

  /**
   * Calculate memory usage, limit, and percentage from stats
   *
   * @param array $stats Raw Docker stats
   * @return array ['usage' => int, 'limit' => int, 'percent' => float]
   */
  private function calculateMemoryStats($stats)
  {
    $memStats = $stats['memory_stats'] ?? [];
    $usage = $memStats['usage'] ?? 0;
    $limit = $memStats['limit'] ?? 1;
    $percent = $limit > 0 ? round(($usage / $limit) * 100, 2) : 0;

    return ['usage' => $usage, 'limit' => $limit, 'percent' => $percent];
  }

  /**
   * Calculate block I/O read and write totals from stats
   *
   * @param array $stats Raw Docker stats
   * @return array ['read' => int, 'write' => int]
   */
  private function calculateBlockIO($stats)
  {
    $read = 0;
    $write = 0;
    $blkioStats = $stats['blkio_stats']['io_service_bytes_recursive'] ?? [];

    foreach ($blkioStats as $entry) {
      $op = strtolower($entry['op'] ?? '');
      if ($op === 'read') {
        $read += $entry['value'] ?? 0;
      } elseif ($op === 'write') {
        $write += $entry['value'] ?? 0;
      }
    }

    return ['read' => $read, 'write' => $write];
  }

  /**
   * Calculate network I/O rx and tx totals from stats
   *
   * @param array $stats Raw Docker stats
   * @return array ['rx' => int, 'tx' => int]
   */
  private function calculateNetworkIO($stats)
  {
    $rx = 0;
    $tx = 0;
    $networks = $stats['networks'] ?? [];

    foreach ($networks as $iface) {
      $rx += $iface['rx_bytes'] ?? 0;
      $tx += $iface['tx_bytes'] ?? 0;
    }

    return ['rx' => $rx, 'tx' => $tx];
  }

  /**
   * Calculate PID count from stats
   *
   * @param array $stats Raw Docker stats
   * @return int Number of PIDs
   */
  private function calculatePids($stats)
  {
    return $stats['pids_stats']['current'] ?? 0;
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
    $this->lastError = '';

    if (!file_exists($this->socketPath)) {
      $this->lastError = "Docker socket not found: {$this->socketPath}";
      error_log($this->lastError);
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
      $this->lastError = "Docker API error: {$error}";
      error_log($this->lastError);
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

    // Extract error message from Docker API response
    if ($httpCode < 200 || $httpCode >= 300) {
      $errorMsg = "Docker API HTTP {$httpCode}";
      $decoded = json_decode($response, true);
      if ($decoded && isset($decoded['message'])) {
        $errorMsg .= ': ' . $decoded['message'];
      } elseif ($response) {
        $errorMsg .= ': ' . substr($response, 0, 500);
      }
      $this->lastError = $errorMsg;
      error_log($this->lastError);
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
