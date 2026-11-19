<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * scripts/api-plugin.sh, the install step of the GraphQL backend. The script
 * runs against a copy whose paths point into a temp directory, with stubs for
 * unraid-api, curl, node, php, flock and sleep first on PATH. The stubs log every
 * call and model one fact: the API serves the backend code it had at its last
 * start, and `plugins install` changes the files on disk but not that.
 */
final class ApiPluginScriptTest extends TestCase
{
  private const SCRIPT = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/scripts/api-plugin.sh';
  private const PKG = 'unraid-api-plugin-docker-folders';

  private string $root;

  protected function setUp(): void
  {
    if (trim((string) shell_exec('command -v bash')) === '') {
      $this->markTestSkipped('bash is not installed');
    }
    $this->root = sys_get_temp_dir() . '/apiplugin-' . bin2hex(random_bytes(4));
    foreach (['bin', 'emhttp/plugins/unraid-docker-folders-modern/api-plugin', 'boot/plugins/unraid-docker-folders-modern', 'run', 'api/node_modules/' . self::PKG] as $d) {
      mkdir($this->root . '/' . $d, 0777, true);
    }
    $this->writeStubs();
    $this->writeScriptCopy();
    // The bundled tarball: version 2, hash NEW.
    $this->makeTarball($this->root . '/emhttp/plugins/unraid-docker-folders-modern/api-plugin/' . self::PKG . '-2.tgz', '2', 'NEW');
  }

  protected function tearDown(): void
  {
    exec('rm -rf ' . escapeshellarg($this->root));
  }

  private function stub(string $name, string $body): void
  {
    file_put_contents($this->root . '/bin/' . $name, "#!/bin/bash\n" . $body);
    chmod($this->root . '/bin/' . $name, 0755);
  }

  private function writeStubs(): void
  {
    $r = $this->root;
    $pkgDir = $r . '/api/node_modules/' . self::PKG;
    $this->stub('sleep', "exit 0\n");
    $this->stub('php', "exit 0\n");
    // busybox flock has no -w, and the lock is not under test.
    $this->stub('flock', "exit 0\n");
    // package_id() only: the last argument is a file, or "-" for stdin.
    $this->stub('node', <<<'SH'
f="${@: -1}"
if [ "$f" = "-" ]; then j=$(cat); else j=$(cat "$f" 2>/dev/null); fi
v=$(printf '%s' "$j" | grep -o '"version": *"[^"]*"' | head -1 | sed 's/.*: *"\(.*\)"/\1/')
h=$(printf '%s' "$j" | grep -o '"contentHash": *"[^"]*"' | head -1 | sed 's/.*: *"\(.*\)"/\1/')
echo "$v $h"
SH);
    // The probe answers only while the API serves code.
    $this->stub('curl', <<<SH
[ -f "{$r}/served" ] && echo '{"data":{"dockerFoldersInfo":{"version":"x"}}}'
exit 0
SH);
    $this->stub('unraid-api', <<<SH
echo "\$*" >> "{$r}/calls.log"
case "\$1" in
  status) [ -f "{$r}/online" ] && echo "Status : online" || echo "Status : offline" ;;
  stop) rm -f "{$r}/online" "{$r}/served" ;;
  start)
    touch "{$r}/online"
    # The API loads the code on disk at start, unless the test breaks that.
    if [ ! -f "{$r}/start-fails" ] && [ -f "{$pkgDir}/package.json" ]; then
      cp "{$pkgDir}/package.json" "{$r}/served"
    fi ;;
  plugins)
    case "\$2" in
      install)
        tar -xzOf "\$3" package/package.json > "{$pkgDir}/package.json"
        echo "{\"plugins\":[\"\$3\"]}" > "{$r}/api/package.json" ;;
      remove) rm -rf "{$pkgDir}" ;;
    esac ;;
esac
exit 0
SH);
  }

  private function writeScriptCopy(): void
  {
    $r = $this->root;
    $src = file_get_contents(self::SCRIPT);
    $map = [
      '#^export PATH=.*$#m' => 'export PATH="' . $r . '/bin:/usr/bin:/bin"',
      '#^PLUGIN_DIR="/usr/local/emhttp/plugins/#m' => 'PLUGIN_DIR="' . $r . '/emhttp/plugins/',
      '#^CONFIG_DIR="/boot/config/plugins/#m' => 'CONFIG_DIR="' . $r . '/boot/plugins/',
      '#^STATE_FILE="/var/run/#m' => 'STATE_FILE="' . $r . '/run/',
      '#^LOCK_FILE="/var/run/#m' => 'LOCK_FILE="' . $r . '/run/',
      '#^API_CONFIG="[^"]*"#m' => 'API_CONFIG="' . $r . '/no-api.json"',
      '#^API_DIR="[^"]*"#m' => 'API_DIR="' . $r . '/api"',
    ];
    foreach ($map as $re => $to) {
      $src = preg_replace($re, str_replace('$', '\$', $to), $src, -1, $n);
      $this->assertSame(1, $n, "the script no longer matches $re");
    }
    file_put_contents($r . '/api-plugin.sh', $src);
  }

  private function makeTarball(string $path, string $version, string $hash): void
  {
    $tmp = $this->root . '/tgz-' . bin2hex(random_bytes(3));
    mkdir($tmp . '/package', 0777, true);
    file_put_contents($tmp . '/package/package.json', json_encode(['name' => self::PKG, 'version' => $version, 'contentHash' => $hash]));
    exec('tar -czf ' . escapeshellarg($path) . ' -C ' . escapeshellarg($tmp) . ' package');
    exec('rm -rf ' . escapeshellarg($tmp));
  }

  /** The backend as the API last installed it: version, hash, tarball on /boot. */
  private function installed(string $version, string $hash, bool $linked): void
  {
    file_put_contents($this->root . '/api/node_modules/' . self::PKG . '/package.json', json_encode(['version' => $version, 'contentHash' => $hash]));
    if ($linked) {
      $name = self::PKG . '-' . $version . '.tgz';
      mkdir($this->root . '/boot/plugins/unraid-docker-folders-modern/api-plugin', 0777, true);
      touch($this->root . '/boot/plugins/unraid-docker-folders-modern/api-plugin/' . $name);
      file_put_contents($this->root . '/api/package.json', json_encode(['plugins' => [$name]]));
    }
  }

  /** The API runs and serves what is installed. */
  private function apiRunning(): void
  {
    touch($this->root . '/online');
    copy($this->root . '/api/node_modules/' . self::PKG . '/package.json', $this->root . '/served');
  }

  /** @return array{code: int, out: string} */
  private function install(string ...$args): array
  {
    exec('bash ' . escapeshellarg($this->root . '/api-plugin.sh') . ' install ' . implode(' ', array_map('escapeshellarg', $args)) . ' 2>&1 </dev/null', $out, $code);
    return ['code' => $code, 'out' => implode("\n", $out)];
  }

  private function calls(string $verb): int
  {
    $log = @file($this->root . '/calls.log', FILE_IGNORE_NEW_LINES) ?: [];
    return count(array_filter($log, fn($l) => $l === $verb));
  }

  private function servedHash(): ?string
  {
    $f = $this->root . '/served';
    return is_file($f) ? (json_decode((string) file_get_contents($f), true)['contentHash'] ?? null) : null;
  }

  private function state(): string
  {
    $f = glob($this->root . '/run/*.state')[0] ?? null;
    return $f ? (json_decode((string) file_get_contents($f), true)['state'] ?? '') : '';
  }

  #[Test]
  public function an_update_that_changed_the_backend_stops_and_starts_the_api_once(): void
  {
    $this->installed('1', 'OLD', true);
    $this->apiRunning();
    $r = $this->install();
    $this->assertSame(0, $r['code'], $r['out']);
    $this->assertSame(1, $this->calls('stop'));
    $this->assertSame(1, $this->calls('start'));
    $this->assertSame('NEW', $this->servedHash(), 'the API serves the new code');
    $this->assertStringContainsString('Reloading the Unraid API to load the updated GraphQL backend', $r['out']);
    $this->assertSame('ready', $this->state());
  }

  #[Test]
  public function the_same_code_installs_and_restarts_nothing(): void
  {
    $this->installed('1', 'NEW', true);
    $this->apiRunning();
    $r = $this->install();
    $this->assertSame(0, $r['code'], $r['out']);
    $this->assertSame(0, $this->calls('stop'));
    $this->assertSame(0, $this->calls('start'));
    $this->assertSame(0, $this->calls('plugins install ' . $this->root . '/boot/plugins/unraid-docker-folders-modern/api-plugin/' . self::PKG . '-2.tgz'));
    $this->assertStringNotContainsString('Reloading', $r['out']);
  }

  #[Test]
  public function an_update_with_the_api_offline_does_not_start_it(): void
  {
    $this->installed('1', 'OLD', true);
    $r = $this->install();
    $this->assertSame(0, $r['code'], $r['out']);
    $this->assertSame(0, $this->calls('stop'));
    $this->assertSame(0, $this->calls('start'));
    $this->assertStringNotContainsString('Reloading', $r['out']);
    $this->assertSame('installed', $this->state());
  }

  #[Test]
  public function a_first_install_stops_and_starts_the_api_once(): void
  {
    $touch = $this->root . '/online';
    touch($touch); // running, with no backend loaded
    $r = $this->install();
    $this->assertSame(0, $r['code'], $r['out']);
    $this->assertSame(1, $this->calls('stop'));
    $this->assertSame(1, $this->calls('start'));
    $this->assertSame('NEW', $this->servedHash());
    $this->assertStringNotContainsString('Reloading', $r['out']);
  }

  #[Test]
  public function a_reload_that_does_not_bring_the_backend_back_is_reported_as_failed(): void
  {
    $this->installed('1', 'OLD', true);
    $this->apiRunning();
    touch($this->root . '/start-fails');
    $r = $this->install();
    $this->assertSame(1, $r['code'], $r['out']);
    $this->assertSame(1, $this->calls('stop'));
    $this->assertSame('failed', $this->state());
    // Not activating: the new backend stays installed.
    $this->assertDirectoryExists($this->root . '/api/node_modules/' . self::PKG);
  }

  #[Test]
  public function a_failed_reload_during_activation_removes_the_backend(): void
  {
    $this->installed('1', 'OLD', true);
    $this->apiRunning();
    touch($this->root . '/start-fails');
    $r = $this->install('--activate');
    $this->assertSame(1, $r['code'], $r['out']);
    $this->assertSame('failed', $this->state());
    $this->assertDirectoryDoesNotExist($this->root . '/api/node_modules/' . self::PKG);
  }
}
