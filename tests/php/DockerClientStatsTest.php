<?php

declare(strict_types=1);

// Define constants required by DockerClient before loading it
if (!defined('DOCKER_SOCKET')) {
    define('DOCKER_SOCKET', '/var/run/docker.sock');
}
if (!defined('DOCKER_API_VERSION')) {
    define('DOCKER_API_VERSION', 'v1.41');
}

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * Tests for DockerClient private stat calculation helpers.
 *
 * Uses ReflectionMethod to invoke private methods directly,
 * testing the calculation logic in isolation from Docker API calls.
 */
final class DockerClientStatsTest extends TestCase
{
    private DockerClient $client;
    private ReflectionClass $reflection;

    protected function setUp(): void
    {
        $this->client = new DockerClient();
        $this->reflection = new ReflectionClass(DockerClient::class);
    }

    /**
     * Invoke a private method on the DockerClient instance.
     */
    private function invoke(string $method, array $args): mixed
    {
        $m = $this->reflection->getMethod($method);
        $m->setAccessible(true);
        return $m->invoke($this->client, ...$args);
    }

    // ---------------------------------------------------------------
    // calculateCpuPercent()
    // ---------------------------------------------------------------

    #[Test]
    public function cpuPercent_normal_usage(): void
    {
        $stats = [
            'cpu_stats' => [
                'cpu_usage' => ['total_usage' => 200000000],
                'system_cpu_usage' => 1000000000,
                'online_cpus' => 4,
            ],
            'precpu_stats' => [
                'cpu_usage' => ['total_usage' => 100000000],
                'system_cpu_usage' => 500000000,
            ],
        ];

        // cpuDelta = 200M - 100M = 100M
        // systemDelta = 1000M - 500M = 500M
        // (100M / 500M) * 4 * 100 = 80.0
        $result = $this->invoke('calculateCpuPercent', [$stats]);
        $this->assertSame(80.0, $result);
    }

    #[Test]
    public function cpuPercent_zero_system_delta_returns_zero(): void
    {
        $stats = [
            'cpu_stats' => [
                'cpu_usage' => ['total_usage' => 100],
                'system_cpu_usage' => 500,
                'online_cpus' => 2,
            ],
            'precpu_stats' => [
                'cpu_usage' => ['total_usage' => 100],
                'system_cpu_usage' => 500,
            ],
        ];

        $result = $this->invoke('calculateCpuPercent', [$stats]);
        $this->assertSame(0.0, $result);
    }

    #[Test]
    public function cpuPercent_missing_fields_returns_zero(): void
    {
        $result = $this->invoke('calculateCpuPercent', [[]]);
        $this->assertSame(0.0, $result);
    }

    #[Test]
    public function cpuPercent_single_cpu(): void
    {
        $stats = [
            'cpu_stats' => [
                'cpu_usage' => ['total_usage' => 50000],
                'system_cpu_usage' => 200000,
                'online_cpus' => 1,
            ],
            'precpu_stats' => [
                'cpu_usage' => ['total_usage' => 0],
                'system_cpu_usage' => 0,
            ],
        ];

        // (50000 / 200000) * 1 * 100 = 25.0
        $result = $this->invoke('calculateCpuPercent', [$stats]);
        $this->assertSame(25.0, $result);
    }

    #[Test]
    public function cpuPercent_defaults_online_cpus_to_1(): void
    {
        $stats = [
            'cpu_stats' => [
                'cpu_usage' => ['total_usage' => 50000],
                'system_cpu_usage' => 200000,
                // online_cpus missing
            ],
            'precpu_stats' => [
                'cpu_usage' => ['total_usage' => 0],
                'system_cpu_usage' => 0,
            ],
        ];

        $result = $this->invoke('calculateCpuPercent', [$stats]);
        $this->assertSame(25.0, $result);
    }

    #[Test]
    public function cpuPercent_rounds_to_two_decimals(): void
    {
        $stats = [
            'cpu_stats' => [
                'cpu_usage' => ['total_usage' => 1000],
                'system_cpu_usage' => 30000,
                'online_cpus' => 1,
            ],
            'precpu_stats' => [
                'cpu_usage' => ['total_usage' => 0],
                'system_cpu_usage' => 0,
            ],
        ];

        // (1000 / 30000) * 1 * 100 = 3.333... → 3.33
        $result = $this->invoke('calculateCpuPercent', [$stats]);
        $this->assertSame(3.33, $result);
    }

    // ---------------------------------------------------------------
    // calculateMemoryStats()
    // ---------------------------------------------------------------

    #[Test]
    public function memoryStats_normal_usage(): void
    {
        $stats = [
            'memory_stats' => [
                'usage' => 524288000,   // ~500 MB
                'limit' => 1073741824,  // 1 GB
            ],
        ];

        $result = $this->invoke('calculateMemoryStats', [$stats]);

        $this->assertSame(524288000, $result['usage']);
        $this->assertSame(1073741824, $result['limit']);
        $this->assertSame(48.83, $result['percent']);
    }

    #[Test]
    public function memoryStats_missing_fields(): void
    {
        $result = $this->invoke('calculateMemoryStats', [[]]);

        $this->assertSame(0, $result['usage']);
        $this->assertSame(1, $result['limit']);
        $this->assertSame(0.0, $result['percent']);
    }

    #[Test]
    public function memoryStats_zero_limit_returns_zero_percent(): void
    {
        $stats = [
            'memory_stats' => [
                'usage' => 100,
                'limit' => 0,
            ],
        ];

        $result = $this->invoke('calculateMemoryStats', [$stats]);
        $this->assertSame(0, $result['percent']);
    }

    #[Test]
    public function memoryStats_full_usage(): void
    {
        $stats = [
            'memory_stats' => [
                'usage' => 1000,
                'limit' => 1000,
            ],
        ];

        $result = $this->invoke('calculateMemoryStats', [$stats]);
        $this->assertSame(100.0, $result['percent']);
    }

    // ---------------------------------------------------------------
    // calculateBlockIO()
    // ---------------------------------------------------------------

    #[Test]
    public function blockIO_sums_read_and_write(): void
    {
        $stats = [
            'blkio_stats' => [
                'io_service_bytes_recursive' => [
                    ['op' => 'Read', 'value' => 1024],
                    ['op' => 'Write', 'value' => 2048],
                    ['op' => 'Read', 'value' => 512],
                    ['op' => 'Write', 'value' => 256],
                ],
            ],
        ];

        $result = $this->invoke('calculateBlockIO', [$stats]);
        $this->assertSame(1536, $result['read']);
        $this->assertSame(2304, $result['write']);
    }

    #[Test]
    public function blockIO_missing_fields(): void
    {
        $result = $this->invoke('calculateBlockIO', [[]]);
        $this->assertSame(0, $result['read']);
        $this->assertSame(0, $result['write']);
    }

    #[Test]
    public function blockIO_ignores_non_read_write_ops(): void
    {
        $stats = [
            'blkio_stats' => [
                'io_service_bytes_recursive' => [
                    ['op' => 'Read', 'value' => 100],
                    ['op' => 'Sync', 'value' => 999],
                    ['op' => 'Async', 'value' => 888],
                    ['op' => 'Write', 'value' => 200],
                ],
            ],
        ];

        $result = $this->invoke('calculateBlockIO', [$stats]);
        $this->assertSame(100, $result['read']);
        $this->assertSame(200, $result['write']);
    }

    #[Test]
    public function blockIO_handles_case_insensitive_ops(): void
    {
        $stats = [
            'blkio_stats' => [
                'io_service_bytes_recursive' => [
                    ['op' => 'READ', 'value' => 100],
                    ['op' => 'WRITE', 'value' => 200],
                    ['op' => 'read', 'value' => 50],
                    ['op' => 'write', 'value' => 75],
                ],
            ],
        ];

        $result = $this->invoke('calculateBlockIO', [$stats]);
        $this->assertSame(150, $result['read']);
        $this->assertSame(275, $result['write']);
    }

    #[Test]
    public function blockIO_handles_null_recursive_array(): void
    {
        $stats = [
            'blkio_stats' => [
                'io_service_bytes_recursive' => null,
            ],
        ];

        $result = $this->invoke('calculateBlockIO', [$stats]);
        $this->assertSame(0, $result['read']);
        $this->assertSame(0, $result['write']);
    }

    // ---------------------------------------------------------------
    // calculateNetworkIO()
    // ---------------------------------------------------------------

    #[Test]
    public function networkIO_sums_across_interfaces(): void
    {
        $stats = [
            'networks' => [
                'eth0' => ['rx_bytes' => 1000, 'tx_bytes' => 2000],
                'eth1' => ['rx_bytes' => 500, 'tx_bytes' => 300],
            ],
        ];

        $result = $this->invoke('calculateNetworkIO', [$stats]);
        $this->assertSame(1500, $result['rx']);
        $this->assertSame(2300, $result['tx']);
    }

    #[Test]
    public function networkIO_missing_fields(): void
    {
        $result = $this->invoke('calculateNetworkIO', [[]]);
        $this->assertSame(0, $result['rx']);
        $this->assertSame(0, $result['tx']);
    }

    #[Test]
    public function networkIO_single_interface(): void
    {
        $stats = [
            'networks' => [
                'eth0' => ['rx_bytes' => 12345, 'tx_bytes' => 67890],
            ],
        ];

        $result = $this->invoke('calculateNetworkIO', [$stats]);
        $this->assertSame(12345, $result['rx']);
        $this->assertSame(67890, $result['tx']);
    }

    #[Test]
    public function networkIO_handles_missing_bytes_fields(): void
    {
        $stats = [
            'networks' => [
                'eth0' => [],
                'eth1' => ['rx_bytes' => 100],
            ],
        ];

        $result = $this->invoke('calculateNetworkIO', [$stats]);
        $this->assertSame(100, $result['rx']);
        $this->assertSame(0, $result['tx']);
    }

    // ---------------------------------------------------------------
    // calculatePids()
    // ---------------------------------------------------------------

    #[Test]
    public function pids_returns_current_count(): void
    {
        $stats = ['pids_stats' => ['current' => 42]];

        $result = $this->invoke('calculatePids', [$stats]);
        $this->assertSame(42, $result);
    }

    #[Test]
    public function pids_missing_fields_returns_zero(): void
    {
        $result = $this->invoke('calculatePids', [[]]);
        $this->assertSame(0, $result);
    }

    #[Test]
    public function pids_missing_current_returns_zero(): void
    {
        $stats = ['pids_stats' => []];

        $result = $this->invoke('calculatePids', [$stats]);
        $this->assertSame(0, $result);
    }
}
