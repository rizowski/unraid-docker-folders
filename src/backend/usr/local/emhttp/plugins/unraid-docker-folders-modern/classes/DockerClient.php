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
  private $imageInfoCache = [];

  private static $cgroupLayout = null;
  private static $cgroupLayoutDetected = false;

  const SLOW_CACHE_PATH = '/tmp/unraid-docker-slow-stats.json';
  const CPU_SAMPLES_PATH = '/tmp/unraid-docker-stats-cpu.json';
  const SLOW_CACHE_TTL = 60;

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

    // Build autostart lookup from Unraid XML templates
    $autostartMap = $this->getAutostartMap();

    // Transform Docker API response to our format
    $containers = [];
    foreach ($response as $container) {
      $formatted = $this->formatContainer($container);
      $autostartInfo = $autostartMap[$formatted['name']] ?? null;
      $formatted['autostart'] = $autostartInfo ? $autostartInfo['autostart'] : false;
      $formatted['autostartDelay'] = $autostartInfo ? $autostartInfo['autostartDelay'] : 0;
      $containers[] = $formatted;
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
    $response = $this->request('POST', "/containers/{$id}/stop?t={$timeout}", null, $timeout + 5);
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
    $response = $this->request('POST', "/containers/{$id}/restart?t={$timeout}", null, $timeout + 5);
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
   * Remove a Docker image
   */
  public function removeImage($imageId, $force = false)
  {
    $params = $force ? '?force=1' : '';
    $response = $this->request('DELETE', "/images/" . urlencode($imageId) . $params);
    return $response !== false;
  }

  /**
   * Get container logs
   *
   * Docker's /logs endpoint returns a multiplexed byte stream with 8-byte
   * frame headers (byte 0 = stream type, bytes 4-7 = frame size big-endian,
   * then payload). This method strips those headers and ANSI escape sequences
   * for clean text output.
   *
   * @param string $id Container ID or name
   * @param int $tail Number of lines from end
   * @return string Logs
   */
  public function getContainerLogs($id, $tail = 100)
  {
    $raw = $this->requestRaw('GET', "/containers/{$id}/logs?stdout=1&stderr=1&timestamps=1&tail={$tail}");
    if ($raw === false || $raw === '') {
      return '';
    }

    // Strip Docker multiplexed stream headers (8 bytes per frame)
    $output = '';
    $offset = 0;
    $len = strlen($raw);
    while ($offset + 8 <= $len) {
      // bytes 4-7: payload size (big-endian uint32)
      $frameSize = unpack('N', substr($raw, $offset + 4, 4))[1];
      $offset += 8;
      if ($frameSize > 0 && $offset + $frameSize <= $len) {
        $output .= substr($raw, $offset, $frameSize);
      }
      $offset += $frameSize;
    }

    // Strip ANSI escape sequences
    $output = preg_replace('/\x1b\[[0-9;]*[a-zA-Z]/', '', $output);

    // Simplify Docker RFC3339Nano timestamps to YYYY-MM-DD HH:MM:SS
    $output = preg_replace(
      '/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.\d+Z/',
      '$1 $2',
      $output
    );

    // Remove Docker's timestamp prefix when the log line already contains its own timestamp
    $lines = explode("\n", rtrim($output, "\n"));
    foreach ($lines as &$line) {
      // Docker's simplified prefix is "YYYY-MM-DD HH:MM:SS " (20 chars).
      // If the remaining content starts with a date or time pattern, strip the prefix.
      if (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (\d{4}[-\/]|\d{2}:\d{2}|\[\d{4}[-\/]|\d{2}[-\/]\w{3}[-\/])/', $line)) {
        $line = substr($line, 20);
      }
    }
    unset($line);

    // Reverse line order so newest lines appear first
    $lines = array_reverse($lines);
    $output = implode("\n", $lines);

    return $output;
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

  private function detectCgroupLayout($fullId)
  {
    if (self::$cgroupLayoutDetected) {
      return self::$cgroupLayout;
    }
    self::$cgroupLayoutDetected = true;

    $patterns = [
      'v2-systemd' => "/sys/fs/cgroup/system.slice/docker-{$fullId}.scope",
      'v2-flat'    => "/sys/fs/cgroup/docker/{$fullId}",
      'v1'         => "/sys/fs/cgroup/cpu/docker/{$fullId}",
    ];

    foreach ($patterns as $layout => $path) {
      if (is_dir($path)) {
        self::$cgroupLayout = $layout;
        return $layout;
      }
    }

    self::$cgroupLayout = null;
    return null;
  }

  private function getCgroupDir($layout, $fullId, $subsystem = null)
  {
    switch ($layout) {
      case 'v2-systemd':
        return "/sys/fs/cgroup/system.slice/docker-{$fullId}.scope";
      case 'v2-flat':
        return "/sys/fs/cgroup/docker/{$fullId}";
      case 'v1':
        $sub = $subsystem ?: 'cpu';
        return "/sys/fs/cgroup/{$sub}/docker/{$fullId}";
      default:
        return null;
    }
  }

  private function readSystemCpuInfo()
  {
    $result = ['system_time' => 0, 'online_cpus' => 1];
    $procStat = @file_get_contents('/proc/stat');
    if ($procStat === false) return $result;

    $firstLine = strtok($procStat, "\n");
    $parts = preg_split('/\s+/', $firstLine);
    if (count($parts) >= 5) {
      $total = 0;
      for ($i = 1; $i < count($parts); $i++) {
        $total += (int) $parts[$i];
      }
      // 1e7 ns per jiffy (100 jiffies/sec on Linux)
      $result['system_time'] = $total * 10000000;
    }
    $cpuCount = preg_match_all('/^cpu\d+/m', $procStat);
    if ($cpuCount > 0) {
      $result['online_cpus'] = $cpuCount;
    }

    return $result;
  }

  private function readCgroupStats($fullId, $layout, $systemCpu)
  {
    $result = [
      'cpu_usage' => 0,
      'system_time' => $systemCpu['system_time'],
      'online_cpus' => $systemCpu['online_cpus'],
      'memory_usage' => 0,
      'memory_limit' => 0,
      'io_read' => 0,
      'io_write' => 0,
      'pids' => 0,
    ];

    if ($layout === 'v1') {
      return $this->readCgroupV1Stats($fullId, $result);
    }

    $dir = $this->getCgroupDir($layout, $fullId);
    if (!$dir || !is_dir($dir)) return null;

    $cpuStat = @file_get_contents($dir . '/cpu.stat');
    if ($cpuStat !== false && preg_match('/usage_usec\s+(\d+)/', $cpuStat, $m)) {
      // cpu.stat reports microseconds; convert to nanoseconds to match v1/Docker convention
      $result['cpu_usage'] = (int) $m[1] * 1000;
    }

    $memCurrent = @file_get_contents($dir . '/memory.current');
    if ($memCurrent !== false) {
      $result['memory_usage'] = (int) trim($memCurrent);
    }
    $memMax = @file_get_contents($dir . '/memory.max');
    if ($memMax !== false) {
      $val = trim($memMax);
      $result['memory_limit'] = ($val === 'max') ? PHP_INT_MAX : (int) $val;
    }

    $ioStat = @file_get_contents($dir . '/io.stat');
    if ($ioStat !== false) {
      foreach (explode("\n", $ioStat) as $line) {
        if (preg_match('/rbytes=(\d+)/', $line, $m)) {
          $result['io_read'] += (int) $m[1];
        }
        if (preg_match('/wbytes=(\d+)/', $line, $m)) {
          $result['io_write'] += (int) $m[1];
        }
      }
    }

    $pidsCurrent = @file_get_contents($dir . '/pids.current');
    if ($pidsCurrent !== false) {
      $result['pids'] = (int) trim($pidsCurrent);
    }

    return $result;
  }

  private function readCgroupV1Stats($fullId, $result)
  {
    $cpuDir = $this->getCgroupDir('v1', $fullId, 'cpuacct');
    $usage = @file_get_contents($cpuDir . '/cpuacct.usage');
    if ($usage !== false) {
      $result['cpu_usage'] = (int) trim($usage);
    }

    $memDir = $this->getCgroupDir('v1', $fullId, 'memory');
    $memUsage = @file_get_contents($memDir . '/memory.usage_in_bytes');
    if ($memUsage !== false) {
      $result['memory_usage'] = (int) trim($memUsage);
    }
    $memLimit = @file_get_contents($memDir . '/memory.limit_in_bytes');
    if ($memLimit !== false) {
      $val = (int) trim($memLimit);
      $result['memory_limit'] = ($val > 1e17) ? PHP_INT_MAX : $val;
    }

    $blkDir = $this->getCgroupDir('v1', $fullId, 'blkio');
    $blkio = @file_get_contents($blkDir . '/blkio.throttle.io_service_bytes');
    if ($blkio !== false) {
      foreach (explode("\n", $blkio) as $line) {
        $parts = preg_split('/\s+/', trim($line));
        if (count($parts) === 3) {
          if (strtolower($parts[1]) === 'read') $result['io_read'] += (int) $parts[2];
          if (strtolower($parts[1]) === 'write') $result['io_write'] += (int) $parts[2];
        }
      }
    }

    $pidsDir = $this->getCgroupDir('v1', $fullId, 'pids');
    $pidsCurrent = @file_get_contents($pidsDir . '/pids.current');
    if ($pidsCurrent !== false) {
      $result['pids'] = (int) trim($pidsCurrent);
    }

    return $result;
  }

  private function readNetworkStats($fullId, $layout)
  {
    $rx = 0;
    $tx = 0;

    $dir = $this->getCgroupDir($layout, $fullId, 'pids');
    if (!$dir) return ['rx' => 0, 'tx' => 0];

    $procsFile = ($layout === 'v1') ? $dir . '/cgroup.procs' : $this->getCgroupDir($layout, $fullId) . '/cgroup.procs';
    $procs = @file_get_contents($procsFile);
    if ($procs === false) return ['rx' => 0, 'tx' => 0];

    $pid = (int) strtok(trim($procs), "\n");
    if ($pid <= 0) return ['rx' => 0, 'tx' => 0];

    // /proc/{pid}/net/dev reads from the container's network namespace
    $netDev = @file_get_contents("/proc/{$pid}/net/dev");
    if ($netDev === false) return ['rx' => 0, 'tx' => 0];

    foreach (explode("\n", $netDev) as $line) {
      $line = trim($line);
      if (strpos($line, ':') === false) continue;
      list($iface, $stats) = explode(':', $line, 2);
      $iface = trim($iface);
      if ($iface === 'lo') continue;

      $fields = preg_split('/\s+/', trim($stats));
      if (count($fields) >= 9) {
        $rx += (int) $fields[0];
        $tx += (int) $fields[8];
      }
    }

    return ['rx' => $rx, 'tx' => $tx];
  }

  private function loadJsonCache($path)
  {
    $data = @file_get_contents($path);
    if ($data === false) return [];
    $decoded = json_decode($data, true);
    return is_array($decoded) ? $decoded : [];
  }

  private function saveJsonCache($path, $data)
  {
    $tmp = $path . '.tmp.' . getmypid();
    file_put_contents($tmp, json_encode($data));
    rename($tmp, $path);
  }

  /**
   * Fast batch stats using cgroup filesystem reads + cached slow data.
   * Falls back to Docker API if cgroup reads are unavailable.
   *
   * @param array $ids Array of container IDs (full 64-char format from frontend)
   * @return array Associative array of ['id' => formattedStats | null, ...]
   */
  public function fetchBatchStatsFast($ids)
  {
    if (empty($ids)) return [];

    $layout = $this->detectCgroupLayout($ids[0]);
    if (!$layout) {
      return $this->fetchBatchStats($ids);
    }

    $systemCpu = $this->readSystemCpuInfo();

    $cgroupData = [];
    $netData = [];
    $fallbackSet = [];

    foreach ($ids as $id) {
      $cg = $this->readCgroupStats($id, $layout, $systemCpu);
      if ($cg === null) {
        $fallbackSet[$id] = true;
        continue;
      }

      $cgroupData[$id] = $cg;
      $netData[$id] = $this->readNetworkStats($id, $layout);
    }

    $prevSamples = $this->loadJsonCache(self::CPU_SAMPLES_PATH);
    $newSamples = [];

    foreach ($cgroupData as $id => $cg) {
      $newSamples[$id] = [
        'cpu_usage' => $cg['cpu_usage'],
        'system_time' => $cg['system_time'],
      ];
    }

    $slowCache = $this->loadJsonCache(self::SLOW_CACHE_PATH);
    $now = time();
    $staleIds = [];

    foreach ($ids as $id) {
      if (isset($fallbackSet[$id])) continue;
      $cached = $slowCache[$id] ?? null;
      if (!$cached || ($now - ($cached['cachedAt'] ?? 0)) > self::SLOW_CACHE_TTL) {
        $staleIds[] = $id;
      }
    }

    if (!empty($staleIds)) {
      $inspectRequests = [];
      foreach ($staleIds as $id) {
        $inspectRequests[$id] = "/containers/{$id}/json";
      }
      $inspectResults = $this->requestMulti($inspectRequests);

      $imageMap = [];
      foreach ($inspectResults as $id => $inspect) {
        if (!$inspect) continue;
        $imageId = $inspect['Image'] ?? '';
        if ($imageId) $imageMap[$imageId][] = $id;
      }

      $imageRequests = [];
      foreach (array_keys($imageMap) as $imageId) {
        $imageRequests[$imageId] = "/images/{$imageId}/json";
      }
      $imageResults = $this->requestMulti($imageRequests);

      foreach ($staleIds as $id) {
        $inspect = $inspectResults[$id] ?? null;
        if (!$inspect) continue;

        $imageId = $inspect['Image'] ?? '';
        $imageSize = 0;
        if ($imageId && isset($imageResults[$imageId])) {
          $imageSize = $imageResults[$imageId]['Size'] ?? 0;
        }

        $fullId = $inspect['Id'] ?? $id;
        $logSize = $this->getContainerLogSize($fullId);

        $slowCache[$id] = [
          'restartCount' => $inspect['RestartCount'] ?? 0,
          'startedAt' => $inspect['State']['StartedAt'] ?? '',
          'imageSize' => $imageSize,
          'logSize' => $logSize,
          'cachedAt' => $now,
        ];
      }

      $this->saveJsonCache(self::SLOW_CACHE_PATH, $slowCache);
    }

    $systemMemLimit = null;
    $output = [];

    foreach ($ids as $id) {
      if (isset($fallbackSet[$id])) {
        $output[$id] = null;
        continue;
      }

      $cg = $cgroupData[$id];
      $net = $netData[$id];
      $prev = $prevSamples[$id] ?? null;
      $slow = $slowCache[$id] ?? [];

      $cpuPercent = 0.0;
      if ($prev) {
        $cpuDelta = $cg['cpu_usage'] - $prev['cpu_usage'];
        $sysDelta = $cg['system_time'] - $prev['system_time'];
        if ($sysDelta > 0 && $cpuDelta >= 0) {
          $cpuPercent = round(($cpuDelta / $sysDelta) * $cg['online_cpus'] * 100, 2);
        }
      }

      $memLimit = $cg['memory_limit'];
      if ($memLimit === PHP_INT_MAX) {
        if ($systemMemLimit === null) {
          $systemMemLimit = 0;
          $memInfo = @file_get_contents('/proc/meminfo');
          if ($memInfo && preg_match('/MemTotal:\s+(\d+)\s+kB/', $memInfo, $m)) {
            $systemMemLimit = (int) $m[1] * 1024;
          }
        }
        $memLimit = $systemMemLimit;
      }

      $memPercent = $memLimit > 0 ? round(($cg['memory_usage'] / $memLimit) * 100, 2) : 0;

      $output[$id] = [
        'cpuPercent' => $cpuPercent,
        'memoryUsage' => $cg['memory_usage'],
        'memoryLimit' => $memLimit,
        'memoryPercent' => $memPercent,
        'blockRead' => $cg['io_read'],
        'blockWrite' => $cg['io_write'],
        'netRx' => $net['rx'],
        'netTx' => $net['tx'],
        'pids' => $cg['pids'],
        'restartCount' => $slow['restartCount'] ?? 0,
        'startedAt' => $slow['startedAt'] ?? '',
        'imageSize' => $slow['imageSize'] ?? 0,
        'logSize' => $slow['logSize'] ?? 0,
      ];
    }

    $this->saveJsonCache(self::CPU_SAMPLES_PATH, $newSamples);

    if (!empty($fallbackSet)) {
      $fallbackStats = $this->fetchBatchStats(array_keys($fallbackSet));
      foreach ($fallbackStats as $id => $stats) {
        $output[$id] = $stats;
      }
    }

    return $output;
  }

  /**
   * Fetch stats for multiple containers in parallel (Docker API fallback)
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

    // Ensure Image is a tag reference, not a SHA digest
    $config['Image'] = $this->resolveImageTag($config['Image'] ?? '', $containerName);

    // Fix empty-object fields: PHP json_decode turns {} into [] (empty array),
    // but Docker expects {} (empty object) for ExposedPorts and Volumes values.
    foreach (['ExposedPorts', 'Volumes'] as $field) {
      if (isset($config[$field]) && is_array($config[$field])) {
        if (empty($config[$field])) {
          $config[$field] = (object) [];
        } else {
          foreach ($config[$field] as $key => $val) {
            if (is_array($val) && empty($val)) {
              $config[$field][$key] = (object) [];
            }
          }
        }
      }
    }

    $createBody = $config;
    $createBody['HostConfig'] = $inspect['HostConfig'] ?? [];

    // Remove read-only HostConfig fields
    unset($createBody['HostConfig']['ContainerIDFile']);

    // Fix PortBindings: PHP json_decode turns {} into [] (empty array),
    // but Docker expects an object/map for PortBindings and each binding value.
    if (isset($createBody['HostConfig']['PortBindings'])) {
      $pb = $createBody['HostConfig']['PortBindings'];
      if (is_array($pb) && empty($pb)) {
        $createBody['HostConfig']['PortBindings'] = (object) [];
      } elseif (is_array($pb)) {
        foreach ($pb as $port => $bindings) {
          if (is_array($bindings) && empty($bindings)) {
            $pb[$port] = [];
          }
        }
        $createBody['HostConfig']['PortBindings'] = (object) $pb;
      }
    }

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
   * Resolve a SHA256 image digest to a human-readable tag.
   *
   * After a pull + recreate the container's Image field may be a sha256 digest
   * pointing to the OLD (now untagged) image. Fallback chain:
   *   1. Unraid's dockerMan XML template (most reliable — has exact user-configured tag)
   *   2. RepoTags on the image (works if image still has tags)
   *   3. Original SHA reference (last resort)
   *
   * @param string $imageRef Image reference (tag or sha256 digest)
   * @param string $containerName Container name for template lookup (optional)
   * @return string Resolved tag or original reference
   */
  private function resolveImageTag($imageRef, $containerName = '')
  {
    if (!$imageRef || strpos($imageRef, 'sha256:') !== 0) {
      return $imageRef;
    }

    // 1. Unraid's dockerMan template is the most reliable source — it has the
    //    exact user-configured image:tag regardless of Docker's internal state.
    if ($containerName) {
      $tag = $this->getImageFromTemplate($containerName);
      if ($tag) {
        return $tag;
      }
    }

    // 2. Try RepoTags from the image metadata
    if (!isset($this->imageInfoCache[$imageRef])) {
      $this->imageInfoCache[$imageRef] = $this->getImageInfo($imageRef);
    }
    $imageInfo = $this->imageInfoCache[$imageRef];

    if ($imageInfo && !empty($imageInfo['RepoTags'])) {
      return $imageInfo['RepoTags'][0];
    }

    return $imageRef;
  }

  /**
   * Read the image reference from an Unraid dockerMan XML template.
   *
   * Templates are stored in /boot/config/plugins/dockerMan/templates-user/
   * with a "my-" prefix (e.g. my-plex.xml). If the prefixed file isn't found,
   * falls back to searching all XML files for a matching <Name> element.
   *
   * @param string $containerName Container name
   * @return string|null Image reference or null if not found
   */
  private function getImageFromTemplate($containerName)
  {
    $safeName = basename($containerName);
    $templateDir = '/boot/config/plugins/dockerMan/templates-user';

    // Try the standard "my-" prefixed path first
    $xml = @simplexml_load_file($templateDir . '/my-' . $safeName . '.xml');
    if ($xml && !empty($xml->Repository)) {
      return (string) $xml->Repository;
    }

    // Fallback: scan all templates for one with a matching <Name>
    $files = @glob($templateDir . '/*.xml');
    if ($files) {
      foreach ($files as $file) {
        $xml = @simplexml_load_file($file);
        if ($xml && isset($xml->Name) && (string) $xml->Name === $containerName && !empty($xml->Repository)) {
          return (string) $xml->Repository;
        }
      }
    }

    return null;
  }

  /**
   * Format container from list endpoint
   *
   * @param array $container Raw container data
   * @return array Formatted container
   */
  /**
   * Build a name->autostart map from Unraid's autostart file and XML templates.
   *
   * Unraid stores which containers autostart in /var/lib/docker/unraid-autostart
   * (flat file, one container name per line). Autostart delay is stored in the
   * XML templates at /boot/config/plugins/dockerMan/templates-user/.
   */
  private function getAutostartMap()
  {
    $map = [];

    // Read autostart names from Unraid's flat file (authoritative source)
    $autostartFile = '/var/lib/docker/unraid-autostart';
    $autostartNames = [];
    if (file_exists($autostartFile)) {
      $lines = @file($autostartFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
      if ($lines) {
        $autostartNames = array_map('trim', $lines);
      }
    }

    // Build delay map from XML templates
    $delayMap = [];
    $templateDir = '/boot/config/plugins/dockerMan/templates-user';
    if (is_dir($templateDir)) {
      $files = glob($templateDir . '/my-*.xml');
      if ($files) {
        foreach ($files as $file) {
          if (substr($file, -4) === '.bak') continue;
          $xml = @file_get_contents($file);
          if ($xml === false) continue;

          $name = null;
          if (preg_match('/<Name>([^<]+)<\/Name>/', $xml, $nm)) {
            $name = trim($nm[1]);
          }
          if (!$name) continue;

          $delay = 0;
          if (preg_match('/<AutostartDelay>(\d+)<\/AutostartDelay>/', $xml, $d)) {
            $delay = (int) $d[1];
          }
          $delayMap[$name] = $delay;
        }
      }
    }

    // Combine: autostart from flat file, delay from XML
    // Include all known container names from both sources
    $allNames = array_unique(array_merge($autostartNames, array_keys($delayMap)));
    foreach ($allNames as $name) {
      $map[$name] = [
        'autostart' => in_array($name, $autostartNames),
        'autostartDelay' => $delayMap[$name] ?? 0,
      ];
    }

    return $map;
  }

  private function formatContainer($container)
  {
    $labels = $container['Labels'] ?? [];
    $name = ltrim($container['Names'][0] ?? '', '/');
    return [
      'id' => $container['Id'],
      'name' => $name,
      'image' => $this->resolveImageTag($container['Image'], $name),
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
    $name = ltrim($container['Name'] ?? '', '/');
    return [
      'id' => $container['Id'],
      'name' => $name,
      'image' => $this->resolveImageTag($container['Config']['Image'] ?? '', $name),
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
   * Make HTTP request to Docker API and return raw response body (no JSON decode)
   *
   * @param string $method HTTP method
   * @param string $path API path
   * @param int $timeout Request timeout in seconds
   * @return string|false Raw response body or false on error
   */
  private function requestRaw($method, $path, $timeout = 5)
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

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($error) {
      $this->lastError = "Docker API error: {$error}";
      error_log($this->lastError);
      return false;
    }

    if ($httpCode < 200 || $httpCode >= 300) {
      $this->lastError = "Docker API HTTP {$httpCode}";
      error_log($this->lastError);
      return false;
    }

    return $response;
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
