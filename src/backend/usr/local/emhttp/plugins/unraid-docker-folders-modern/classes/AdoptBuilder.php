<?php
/**
 * Unraid Docker Folders - Adopt Builder
 *
 * Turns a `docker inspect` result into the POST body that Unraid's own
 * /Docker/UpdateContainer endpoint accepts. Unraid then writes the dockerMan
 * template and recreates the container with the net.unraid.docker.* labels, so
 * this plugin never writes into templates-user/ and never calls `docker rm`.
 *
 * The field contract lives in Unraid's Helpers.php::postToXML. Two details from
 * there are load-bearing:
 *
 *  - Most cont* scalars are read WITHOUT a null-coalesce, so every key has to be
 *    present in the POST even when its value is empty.
 *  - The nine conf* arrays are parallel. Entry N of each describes one mapping.
 *
 * Pure transform: no database, no Docker socket, no filesystem. That is what
 * makes it unit-testable in tests/php, unlike FolderManager.
 *
 * @package UnraidDockerModern
 */

class AdoptBuilder
{
  /**
   * Docker's own default shared-memory size. A container that never asked for
   * --shm-size still reports this, so emitting it unconditionally would put a
   * flag in ExtraParams that the user never typed.
   */
  const DEFAULT_SHM_SIZE = 67108864;

  /** Docker's default runtime. Anything else was asked for explicitly. */
  const DEFAULT_RUNTIME = 'runc';

  /**
   * Variables Unraid injects itself in xmlToCommand (Helpers.php:426-430).
   * Carrying them through would re-add them on every adopt and, worse, pin a
   * stale hostname into the template.
   *
   * TZ is deliberately NOT in this list. Unraid adds its own, but a user who set
   * a different one meant it, and the later -e wins.
   */
  const UNRAID_INJECTED_VARS = ['HOST_OS', 'HOST_HOSTNAME', 'HOST_CONTAINERNAME'];

  /** Variable names whose values are hidden in Unraid's form. */
  const SECRET_NAME_PATTERN = '/PASS|SECRET|TOKEN|KEY|CREDENTIAL/i';

  /**
   * Network drivers on which Unraid does NOT publish ports.
   *
   * xmlToCommand switches on the driver (Helpers.php:524). For these it turns
   * every Port config into a TCP_PORT_<n> / UDP_PORT_<n> environment variable
   * instead of emitting `-p`, because the container gets its own address.
   * Verified on a real box: a container moved to br0 (ipvlan) produced
   * `-e TCP_PORT_80=18081` and no `-p` at all.
   */
  const UNPUBLISHED_PORT_DRIVERS = ['host', 'macvlan', 'ipvlan', 'null'];

  /**
   * Build the POST field set for one container.
   *
   * @param array $inspect One element of `docker inspect <container>`
   * @param array $image   One element of `docker inspect <image>`, or [] if the
   *                       image could not be read. Without it every baked-in
   *                       image variable looks user-set, so the caller should
   *                       treat [] as degraded rather than normal.
   * @param string $networkDriver Driver of the container's network, from
   *                       `docker network inspect`. Only used to work out
   *                       whether Unraid will publish ports; '' assumes it will.
   * @return array{fields: array<string,string>, configs: array<int,array<string,string>>, unmapped: string[], imageEnvKnown: bool, portsPublished: bool, networkDriver: string}
   */
  public static function build(array $inspect, array $image = [], $networkDriver = '')
  {
    $config = $inspect['Config'] ?? [];
    $host = $inspect['HostConfig'] ?? [];
    $imageConfig = $image['Config'] ?? [];
    $imageEnvKnown = !empty($imageConfig);

    $unmapped = [];
    $configs = [];

    $network = (string)($host['NetworkMode'] ?? 'bridge');

    foreach (self::buildPorts($host, $unmapped) as $entry) {
      $configs[] = $entry;
    }
    foreach (self::buildPaths($inspect) as $entry) {
      $configs[] = $entry;
    }
    foreach (self::buildVariables($config, $imageConfig) as $entry) {
      $configs[] = $entry;
    }
    foreach (self::buildLabels($config, $imageConfig) as $entry) {
      $configs[] = $entry;
    }
    foreach (self::buildDevices($host) as $entry) {
      $configs[] = $entry;
    }

    $fields = [
      // Derived from the container.
      'contName' => ltrim((string)($inspect['Name'] ?? ''), '/'),
      'contRepository' => (string)($config['Image'] ?? ''),
      'contNetwork' => $network,
      'contMyIP' => self::fixedIp($inspect, $network),
      'contPrivileged' => !empty($host['Privileged']) ? 'on' : '',
      'contCPUset' => (string)($host['CpusetCpus'] ?? ''),
      'contPostArgs' => self::postArgs($config, $imageConfig, $unmapped),
      'contExtraParams' => self::extraParams($host, $inspect, $unmapped),
      'contShell' => 'sh',

      // No Docker equivalent exists. Emitted empty on purpose — do not invent
      // values. WebUI and Icon in particular are what the user fills in after
      // the adopt, and leaving them blank is honest rather than lossy.
      'contRegistry' => '',
      'contMyMAC' => '',
      'contSupport' => '',
      'contProject' => '',
      'contReadMe' => '',
      'contOverview' => '',
      'contCategory' => '',
      'contWebUI' => '',
      'contTemplateURL' => '',
      'contIcon' => '',
      'contDonateText' => '',
      'contDonateLink' => '',
      'contRequires' => '',

      // Not a cont* field, and not part of Tailscale's own block: postToXML
      // reads $post['TSstatedir'] unguarded at Helpers.php:198, outside the
      // `if contTailscale == on` branch. Omitting it makes Unraid emit a PHP
      // warning into its own response on every adopt.
      'TSstatedir' => '',
    ];

    return [
      'fields' => $fields,
      'configs' => $configs,
      'unmapped' => array_values(array_unique($unmapped)),
      'imageEnvKnown' => $imageEnvKnown,
      'networkDriver' => (string)$networkDriver,
      'portsPublished' => self::publishesPorts($network, (string)$networkDriver),
    ];
  }

  /**
   * Whether Unraid will emit `-p` for this container's ports.
   *
   * On host, macvlan and ipvlan networks it emits TCP_PORT_n variables instead,
   * and joining another container's namespace leaves no ports of its own. The
   * preview needs this so it does not promise a published port that will not be.
   */
  private static function publishesPorts($network, $driver)
  {
    if (strpos($network, 'container:') === 0) return false;
    if ($network === 'none') return false;
    if ($driver === '') return true;
    return !in_array($driver, self::UNPUBLISHED_PORT_DRIVERS, true);
  }

  /**
   * One <Config> entry with all nine attributes Unraid expects.
   */
  private static function entry($name, $target, $value, $type, $mode = '', $mask = false)
  {
    return [
      'Name' => $name,
      'Target' => $target,
      'Default' => $value,
      'Mode' => $mode,
      'Description' => '',
      'Type' => $type,
      'Display' => 'always',
      'Required' => 'false',
      'Mask' => $mask ? 'true' : 'false',
      'Value' => $value,
    ];
  }

  /**
   * Published ports, from HostConfig.PortBindings.
   *
   * Keys look like "80/tcp". Target is the container port, the value is the host
   * port, Mode is the protocol — see xmlToCommand, which emits
   * `-p host:container/proto`.
   */
  private static function buildPorts(array $host, array &$unmapped)
  {
    $out = [];
    $bindings = $host['PortBindings'] ?? [];
    if (!is_array($bindings)) return $out;

    foreach ($bindings as $spec => $binds) {
      if (!is_array($binds) || !count($binds)) continue;

      [$containerPort, $proto] = array_pad(explode('/', (string)$spec, 2), 2, 'tcp');
      $first = $binds[0];
      $hostPort = (string)($first['HostPort'] ?? '');
      if ($hostPort === '') continue;

      // The template's Port type cannot express a bind address, and it cannot
      // express a second binding for the same container port. Say so rather
      // than dropping either silently.
      $hostIp = (string)($first['HostIp'] ?? '');
      if ($hostIp !== '' && $hostIp !== '0.0.0.0' && $hostIp !== '::') {
        $unmapped[] = "port {$spec} is bound to {$hostIp} only; it will be published on all addresses";
      }
      if (count($binds) > 1) {
        $unmapped[] = "port {$spec} has " . count($binds) . ' host bindings; only ' . $hostPort . ' is kept';
      }

      $out[] = self::entry("Port {$containerPort}", $containerPort, $hostPort, 'Port', $proto);
    }
    return $out;
  }

  /**
   * Bind mounts only, from Mounts.
   *
   * Mounts is used rather than HostConfig.Binds because it is already split into
   * source, destination and mode.
   *
   * Named volumes are deliberately NOT emitted as Path configs. xmlToCommand
   * mkdirs the host side of every Path that does not exist (Helpers.php:130-133),
   * and a volume's "host side" is a bare name. Verified on a real box: adopting a
   * container with `-v adopt2-data:/data` created an empty `adopt2-data`
   * directory relative to the PHP process's working directory. They go through
   * buildVolumeArgs into ExtraParams instead, which is spliced verbatim and
   * never triggers a mkdir.
   */
  private static function buildPaths(array $inspect)
  {
    $out = [];
    foreach ($inspect['Mounts'] ?? [] as $mount) {
      if ((string)($mount['Type'] ?? 'bind') !== 'bind') continue;

      $destination = (string)($mount['Destination'] ?? '');
      $source = (string)($mount['Source'] ?? '');
      if ($destination === '' || $source === '') continue;

      $mode = array_key_exists('RW', $mount) && !$mount['RW'] ? 'ro' : 'rw';
      $out[] = self::entry($destination, $destination, $source, 'Path', $mode);
    }
    return $out;
  }

  /**
   * Named volumes, as raw `-v` flags for ExtraParams.
   *
   * See buildPaths for why these cannot be Path configs. Both sides are escaped
   * because ExtraParams is spliced into the command line without quoting.
   *
   * @return string[]
   */
  private static function buildVolumeArgs(array $inspect)
  {
    $out = [];
    foreach ($inspect['Mounts'] ?? [] as $mount) {
      if ((string)($mount['Type'] ?? '') !== 'volume') continue;

      $destination = (string)($mount['Destination'] ?? '');
      $name = (string)($mount['Name'] ?? '');
      if ($destination === '' || $name === '') continue;

      $mode = array_key_exists('RW', $mount) && !$mount['RW'] ? 'ro' : 'rw';
      $out[] = '-v ' . escapeshellarg($name) . ':' . escapeshellarg($destination) . ':' . $mode;
    }
    return $out;
  }

  /**
   * User-set environment variables.
   *
   * Config.Env merges the image's baked-in ENV with the user's -e flags, so it
   * has to be diffed against the image. Without this every adopted container
   * gains a wall of variables it never asked for, and they then become part of
   * the saved template forever.
   *
   * A variable counts as user-set when the image does not define it at all, or
   * defines it with a different value.
   */
  private static function buildVariables(array $config, array $imageConfig)
  {
    $imageEnv = self::envMap($imageConfig['Env'] ?? []);
    $out = [];

    foreach (self::envMap($config['Env'] ?? []) as $name => $value) {
      if (in_array($name, self::UNRAID_INJECTED_VARS, true)) continue;
      if (array_key_exists($name, $imageEnv) && $imageEnv[$name] === $value) continue;

      $mask = (bool)preg_match(self::SECRET_NAME_PATTERN, $name);
      $out[] = self::entry($name, $name, $value, 'Variable', '', $mask);
    }
    return $out;
  }

  /**
   * User-set labels.
   *
   * Image labels are dropped for the same reason image env is. The unraid labels
   * are dropped because Unraid stamps them itself, and compose labels are
   * dropped because a compose container should not be adopted at all — the UI
   * gates on that separately.
   */
  private static function buildLabels(array $config, array $imageConfig)
  {
    $imageLabels = $imageConfig['Labels'] ?? [];
    if (!is_array($imageLabels)) $imageLabels = [];
    $out = [];

    foreach ($config['Labels'] ?? [] as $key => $value) {
      $key = (string)$key;
      $value = (string)$value;
      if (strpos($key, 'net.unraid.') === 0) continue;
      if (strpos($key, 'com.docker.compose.') === 0) continue;
      if (array_key_exists($key, $imageLabels) && (string)$imageLabels[$key] === $value) continue;

      $out[] = self::entry($key, $key, $value, 'Label');
    }
    return $out;
  }

  /**
   * Device passthrough.
   *
   * xmlToCommand emits `--device=<Value>` and ignores Target for this type
   * (Helpers.php:154-156), so the host path is the value that matters.
   */
  private static function buildDevices(array $host)
  {
    $out = [];
    foreach ($host['Devices'] ?? [] as $device) {
      $hostPath = (string)($device['PathOnHost'] ?? '');
      if ($hostPath === '') continue;
      $inContainer = (string)($device['PathInContainer'] ?? $hostPath);
      $out[] = self::entry($hostPath, $inContainer, $hostPath, 'Device');
    }
    return $out;
  }

  /**
   * Flags with no template field, rendered back into ExtraParams.
   *
   * Unraid splices ExtraParams verbatim into the `docker create` line just
   * before the image name (Helpers.php xmlToCommand), so anything valid on a
   * command line survives. This was confirmed on a real container:
   * --restart=unless-stopped round-tripped untouched.
   */
  private static function extraParams(array $host, array $inspect, array &$unmapped)
  {
    // Named volumes ride here rather than in a Path config — see buildPaths.
    $params = self::buildVolumeArgs($inspect);

    $restart = (string)($host['RestartPolicy']['Name'] ?? '');
    if ($restart !== '' && $restart !== 'no') {
      $retries = (int)($host['RestartPolicy']['MaximumRetryCount'] ?? 0);
      $value = ($restart === 'on-failure' && $retries > 0)
        ? "on-failure:{$retries}"
        : $restart;
      $params[] = '--restart=' . escapeshellarg($value);
    }

    foreach ((array)($host['CapAdd'] ?? []) as $cap) {
      $params[] = '--cap-add=' . escapeshellarg((string)$cap);
    }
    foreach ((array)($host['CapDrop'] ?? []) as $cap) {
      $params[] = '--cap-drop=' . escapeshellarg((string)$cap);
    }
    foreach ((array)($host['SecurityOpt'] ?? []) as $opt) {
      $params[] = '--security-opt ' . escapeshellarg((string)$opt);
    }
    foreach ((array)($host['ExtraHosts'] ?? []) as $entry) {
      $params[] = '--add-host=' . escapeshellarg((string)$entry);
    }
    foreach ((array)($host['Sysctls'] ?? []) as $key => $value) {
      $params[] = '--sysctl ' . escapeshellarg($key . '=' . $value);
    }
    foreach ((array)($host['Ulimits'] ?? []) as $ulimit) {
      $name = (string)($ulimit['Name'] ?? '');
      if ($name === '') continue;
      $soft = (int)($ulimit['Soft'] ?? 0);
      $hard = (int)($ulimit['Hard'] ?? $soft);
      $params[] = '--ulimit ' . escapeshellarg($name . '=' . $soft . ':' . $hard);
    }

    // Cast to int, so not attacker-shaped.
    $shm = (int)($host['ShmSize'] ?? 0);
    if ($shm > 0 && $shm !== self::DEFAULT_SHM_SIZE) {
      $params[] = '--shm-size=' . $shm;
    }

    $runtime = (string)($host['Runtime'] ?? '');
    if ($runtime !== '' && $runtime !== self::DEFAULT_RUNTIME) {
      $params[] = '--runtime=' . escapeshellarg($runtime);
    }

    // Recognised, non-default, and genuinely not expressible. Reported so the
    // preview can warn rather than letting the container come back subtly
    // different.
    if (!empty($host['GroupAdd'])) {
      $unmapped[] = '--group-add (' . implode(', ', (array)$host['GroupAdd']) . ')';
    }
    if (!empty($host['Tmpfs'])) {
      $unmapped[] = '--tmpfs (' . implode(', ', array_keys((array)$host['Tmpfs'])) . ')';
    }
    if (!empty($host['DeviceRequests'])) {
      $unmapped[] = '--gpus / --device-requests';
    }

    return implode(' ', $params);
  }

  /**
   * A command override, which Unraid appends after the image name.
   *
   * Only a Cmd that differs from the image's own default was actually typed by
   * the user. An Entrypoint override has no template field at all, so it is
   * reported instead of guessed at.
   */
  private static function postArgs(array $config, array $imageConfig, array &$unmapped)
  {
    $entrypoint = $config['Entrypoint'] ?? null;
    $imageEntrypoint = $imageConfig['Entrypoint'] ?? null;
    if ($imageConfig && $entrypoint !== null && $entrypoint !== $imageEntrypoint) {
      $unmapped[] = '--entrypoint (' . implode(' ', (array)$entrypoint) . ')';
    }

    $cmd = $config['Cmd'] ?? null;
    if ($cmd === null || !is_array($cmd)) return '';
    if ($imageConfig && ($imageConfig['Cmd'] ?? null) === $cmd) return '';
    // With no image to compare against, assume the Cmd is the image's own.
    // Repeating it is harmless, but inventing one is not.
    if (!$imageConfig) return '';

    // Each element escaped separately. Unraid splices PostArgs into the docker
    // command line raw and runs the result through a shell, so a Cmd element
    // like `daemon off; worker_processes 2;` — which nginx images really do
    // carry — would otherwise end the docker invocation at the semicolon and run
    // the rest as its own shell command. Escaping per element also preserves the
    // original argv boundaries instead of re-splitting on spaces.
    return implode(' ', array_map(fn($part) => escapeshellarg((string)$part), $cmd));
  }

  /**
   * The fixed IP on a custom network, if the user pinned one.
   */
  private static function fixedIp(array $inspect, $network)
  {
    $networks = $inspect['NetworkSettings']['Networks'] ?? [];
    $ipam = $networks[$network]['IPAMConfig'] ?? null;
    if (!is_array($ipam)) return '';
    return (string)($ipam['IPv4Address'] ?? '');
  }

  /**
   * Turn ["NAME=value", ...] into ["NAME" => "value", ...].
   *
   * Split on the first '=' only: values legitimately contain '=' (base64,
   * connection strings), and splitting on all of them corrupts them.
   */
  private static function envMap($env)
  {
    $out = [];
    foreach ((array)$env as $line) {
      $line = (string)$line;
      $pos = strpos($line, '=');
      if ($pos === false) {
        $out[$line] = '';
        continue;
      }
      $out[substr($line, 0, $pos)] = substr($line, $pos + 1);
    }
    return $out;
  }
}
