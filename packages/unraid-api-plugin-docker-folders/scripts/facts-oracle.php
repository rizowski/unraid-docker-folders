<?php
/**
 * Checks src/containers/container-facts.ts against PHP's own extractFacts.
 *
 * Lifts the two pure static methods out of DockerClient.php and runs them, so
 * the comparison uses PHP's code rather than a second reading of it. Feed it
 * `docker inspect` output for real containers, keyed by id, on stdin.
 *
 * On the target server:
 *
 *   node -e 'const {execSync}=require("child_process");
 *     const ids=execSync("docker ps -aq").toString().trim().split("\n");
 *     const out={}; for (const id of ids) out[id]=JSON.parse(execSync(`docker inspect ${id}`))[0];
 *     require("fs").writeFileSync("/tmp/inspects.json", JSON.stringify(out));'
 *   php facts-oracle.php < /tmp/inspects.json > /tmp/facts-php.json
 *
 * Then diff that against extractFacts() over the same input.
 *
 * Nothing it reads or writes may be committed. An inspect payload carries
 * Config.Env, which on a real server holds API keys and passwords. Delete both
 * files afterwards, on the server and locally. The committed tests use
 * synthetic data for this reason.
 *
 * Last run: all 39 containers on the target server agreed, covering 30 with
 * published ports, 3 privileged, 1 with added capabilities, 9 with a user set,
 * 14 setting PUID and 9 setting UMASK.
 */
class Oracle {
  public static function extractFacts(array $inspect)
  {
    $host = isset($inspect['HostConfig']) && is_array($inspect['HostConfig'])
      ? $inspect['HostConfig']
      : [];
    $config = isset($inspect['Config']) && is_array($inspect['Config'])
      ? $inspect['Config']
      : [];

    $capAdd = $host['CapAdd'] ?? [];
    $exposed = $config['ExposedPorts'] ?? [];

    return [
      'ports' => self::parsePortBindings($host['PortBindings'] ?? []),
      'privileged' => !empty($host['Privileged']),
      'capAdd' => is_array($capAdd) ? array_values(array_map('strval', $capAdd)) : [],
      'exposedPorts' => is_array($exposed) ? array_map('strval', array_keys($exposed)) : [],
      // Empty on most containers, because most images declare no USER. When an
      // image does declare one, Docker copies it here, so a value on its own
      // does NOT mean somebody overrode it. The caller pairs this with the
      // image's own user, and only a difference between the two is an override.
      'user' => (string) ($config['User'] ?? ''),
      // The user the process actually ends up as on Unraid. Images from
      // linuxserver.io start as root and drop to these, so they decide who owns
      // the files a container writes into a share, which User above almost
      // never states.
      'puid' => self::envValue($config['Env'] ?? [], 'PUID'),
      'pgid' => self::envValue($config['Env'] ?? [], 'PGID'),
      // Decides the mode of every file the container creates, so it decides
      // whether the user and group above actually keep anybody out. Another
      // linuxserver.io convention; empty means the image never overrode it.
      'umask' => self::envValue($config['Env'] ?? [], 'UMASK'),
    ];
  }

  /**
   * Read one variable out of Docker's ["NAME=value", ...] environment list.
   *
   * Splits on the first '=' only, because a value legitimately contains more of
   * them. Returns '' when the variable is absent, which the frontend reads as
   * "this container does not say who it runs as".
   *
   * A private static helper rather than AdoptBuilder::envMap(): that one is
   * private to another class, and this needs two lookups rather than a whole
   * map. Keeping it here leaves extractFacts() a pure transform that
   * ContainerFactsTest can exercise with one require_once.
   *
   * @param mixed $env
   * @param string $key
   * @return string
   */
  private static function envValue($env, $key)
  {
    $prefix = $key . '=';
    $len = strlen($prefix);

    foreach ((array) $env as $line) {
      $line = (string) $line;
      if (strncmp($line, $prefix, $len) === 0) {
        return substr($line, $len);
      }
    }

    return '';
  }

  private static function parsePortBindings($portBindings)
  {
    if (!is_array($portBindings)) {
      return [];
    }

    $hostPorts = [];
    foreach ($portBindings as $portProto => $bindings) {
      if (empty($bindings) || !is_array($bindings)) continue;

      $parts = explode('/', (string) $portProto);
      $containerPort = (int) $parts[0];
      $type = $parts[1] ?? 'tcp';

      foreach ($bindings as $binding) {
        $hostPort = $binding['HostPort'] ?? '';
        if ($hostPort === '') continue;
        $hostPorts[] = [
          'hostIp' => $binding['HostIp'] ?? '',
          'hostPort' => (int) $hostPort,
          'containerPort' => $containerPort,
          'type' => $type,
        ];
      }
    }

    return $hostPorts;
  }
}
$payloads = json_decode(file_get_contents('php://stdin'), true);
$out = [];
foreach ($payloads as $id => $inspect) {
  $out[$id] = Oracle::extractFacts($inspect);
}
echo json_encode($out), "\n";
