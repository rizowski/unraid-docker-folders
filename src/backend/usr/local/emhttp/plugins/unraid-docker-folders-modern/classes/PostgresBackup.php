<?php
/**
 * Unraid Docker Folders - Postgres backup mode
 *
 * Dumps databases with pg_dump inside the container, through Docker's exec
 * API. Nothing here runs a shell: every command is an argv array, and the
 * password travels as PGPASSWORD in the exec's environment.
 *
 * backup_config in Postgres mode:
 *   { mode: 'postgres', paths: [], postgres: { service?, credentials,
 *     user?, password?, databases: [] }, destination?, retention_count? }
 *
 * credentials is 'env' (the default) or 'custom'. With 'env', every run reads
 * POSTGRES_USER and POSTGRES_PASSWORD from the container, and nothing is
 * stored. With 'custom', the schedule stores the user and password.
 *
 * service names the compose service when the schedule targets a stack. A
 * container schedule has none.
 *
 * postgres.password is write-only. redactConfig() removes it from every
 * schedule the API returns and puts password_set in its place.
 *
 * The static rules are ported to the Unraid API plugin in
 * backups/postgres-backup.ts. Keep the two the same.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/paths.php';
require_once __DIR__ . '/DockerClient.php';

class PostgresBackup
{
  const MODE_FILES = 'files';
  const MODE_POSTGRES = 'postgres';

  const CREDENTIALS_ENV = 'env';
  const CREDENTIALS_CUSTOM = 'custom';

  const MAX_DATABASES = 100;
  const MAX_PASSWORD_LENGTH = 1024;

  // A dump can take hours on a large database. The runner has no web request
  // to hold open, so the limit only stops a hung exec from blocking forever.
  const DUMP_TIMEOUT = 21600;
  const QUERY_TIMEOUT = 30;

  // Env names that hold the superuser credentials. The official image and
  // everything built on it use POSTGRES_*, Bitnami uses POSTGRESQL_*.
  const USER_ENV = ['POSTGRES_USER', 'POSTGRESQL_USERNAME'];
  const PASSWORD_ENV = ['POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD'];

  const LIST_DATABASES_SQL =
    'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1';

  private $docker;

  public function __construct($docker = null)
  {
    $this->docker = $docker ?: new DockerClient();
  }

  /**
   * The backup mode of a backup_config, 'files' when it names none.
   *
   * @param mixed $config Decoded backup_config
   * @return string
   */
  public static function modeOf($config)
  {
    return is_array($config) && isset($config['mode']) && $config['mode'] === self::MODE_POSTGRES
      ? self::MODE_POSTGRES
      : self::MODE_FILES;
  }

  /**
   * The credential source of a postgres block. Anything but 'custom' is 'env'.
   *
   * @param mixed $pg
   * @return string
   */
  public static function credentialsOf($pg)
  {
    return is_array($pg) && isset($pg['credentials']) && $pg['credentials'] === self::CREDENTIALS_CUSTOM
      ? self::CREDENTIALS_CUSTOM
      : self::CREDENTIALS_ENV;
  }

  /**
   * Check a Postgres backup_config. Returns an error message, or null.
   *
   * A database name reaches pg_dump as the value after -d. A leading "-"
   * would read as an option. libpq reads the -d value as a connection string
   * when it contains "=" or starts with "postgresql://" or "postgres://",
   * which could send PGPASSWORD to another host, so those are refused too.
   * The name never becomes a file name: dump files are numbered.
   *
   * @param mixed $config Decoded backup_config
   * @param string $targetType 'container' or 'stack'
   * @param bool $passwordRequired False when a stored password will fill in
   * @return string|null
   */
  public static function validateConfig($config, $targetType, $passwordRequired = true)
  {
    if (!is_array($config) || !isset($config['postgres']) || !is_array($config['postgres'])) {
      return 'Postgres settings are missing';
    }
    $pg = $config['postgres'];

    if ($targetType === 'stack') {
      if (!self::isValidServiceName(isset($pg['service']) ? $pg['service'] : null)) {
        return 'Pick the stack service that runs Postgres';
      }
    } elseif ($targetType !== 'container') {
      return 'Invalid target type';
    }

    if (isset($pg['credentials']) && !in_array($pg['credentials'], [self::CREDENTIALS_ENV, self::CREDENTIALS_CUSTOM], true)) {
      return 'Invalid credentials source';
    }

    if (self::credentialsOf($pg) === self::CREDENTIALS_CUSTOM) {
      if (!self::isValidUser(isset($pg['user']) ? $pg['user'] : '')) {
        return 'Postgres user must be 1-63 letters, digits, or _ . @ -, and must not start with -';
      }
      $password = isset($pg['password']) ? $pg['password'] : null;
      if ($password !== null && (!is_string($password) || strlen($password) > self::MAX_PASSWORD_LENGTH)) {
        return 'Postgres password is too long';
      }
      if ($passwordRequired && ($password === null || $password === '')) {
        return 'Postgres password is required';
      }
    }

    $databases = isset($pg['databases']) ? $pg['databases'] : null;
    if (!is_array($databases) || count($databases) === 0) {
      return 'Pick at least one database';
    }
    if (count($databases) > self::MAX_DATABASES) {
      return 'Too many databases (limit ' . self::MAX_DATABASES . ')';
    }
    $seen = [];
    foreach ($databases as $db) {
      if (!self::isValidDatabaseName($db)) {
        return 'Invalid database name';
      }
      if (isset($seen[$db])) {
        return "Database listed twice: {$db}";
      }
      $seen[$db] = true;
    }

    return null;
  }

  /** @param mixed $name A container name or a compose service name */
  public static function isValidServiceName($name)
  {
    return safePathComponent($name) !== null;
  }

  /** @param mixed $user */
  public static function isValidUser($user)
  {
    return is_string($user)
      && preg_match('/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,62}$/', $user) === 1;
  }

  /** @param mixed $name */
  public static function isValidDatabaseName($name)
  {
    return is_string($name)
      && $name !== ''
      && strlen($name) <= 63
      && $name[0] !== '-'
      && strpos($name, '=') === false
      && strpos($name, "\0") === false
      && preg_match('#^postgres(ql)?://#i', $name) !== 1;
  }

  /**
   * Keep only the keys Postgres mode uses, so nothing else a client sends is
   * stored. Quiesce is dropped: pg_dump reads a consistent snapshot of a
   * running database, so the container is never paused or stopped.
   *
   * @param array $config A config validateConfig() accepted
   * @return array
   */
  public static function normalizeConfig(array $config, $targetType)
  {
    $pg = $config['postgres'];
    $postgres = [];
    if ($targetType === 'stack') {
      $postgres['service'] = $pg['service'];
    }
    $postgres['credentials'] = self::credentialsOf($pg);
    if ($postgres['credentials'] === self::CREDENTIALS_CUSTOM) {
      $postgres['user'] = $pg['user'];
      if (isset($pg['password']) && $pg['password'] !== '') {
        $postgres['password'] = $pg['password'];
      }
    }
    $postgres['databases'] = array_values($pg['databases']);

    $out = ['mode' => self::MODE_POSTGRES, 'paths' => [], 'postgres' => $postgres];
    if (!empty($config['destination'])) {
      $out['destination'] = $config['destination'];
    }
    if (isset($config['retention_count']) && $config['retention_count'] !== null && $config['retention_count'] !== '') {
      $out['retention_count'] = (int) $config['retention_count'];
    }
    return $out;
  }

  /**
   * Fill in the stored password when an update leaves it out.
   *
   * The API never returns the password, so the edit form cannot send it
   * back. An empty password on an update means "keep the saved one".
   *
   * The saved password belongs to one login on one server. It is kept only
   * when the user and the stack service stay the same. The caller passes no
   * stored config when the schedule's target changes.
   *
   * @param array $incoming Decoded backup_config from the request
   * @param mixed $stored The row's backup_config, as a string or an array
   * @return array
   */
  public static function mergeStoredPassword(array $incoming, $stored)
  {
    if (self::modeOf($incoming) !== self::MODE_POSTGRES) {
      return $incoming;
    }
    if (self::credentialsOf($incoming['postgres']) !== self::CREDENTIALS_CUSTOM) {
      return $incoming;
    }
    if (isset($incoming['postgres']['password']) && $incoming['postgres']['password'] !== '') {
      return $incoming;
    }

    if (is_string($stored)) {
      $stored = json_decode($stored, true);
    }
    $sameLogin = isset($stored['postgres'])
      && is_array($stored['postgres'])
      && ($stored['postgres']['user'] ?? null) === ($incoming['postgres']['user'] ?? null)
      && ($stored['postgres']['service'] ?? null) === ($incoming['postgres']['service'] ?? null);
    if (self::modeOf($stored) === self::MODE_POSTGRES
      && $sameLogin
      && isset($stored['postgres']['password'])
      && is_string($stored['postgres']['password'])
      && $stored['postgres']['password'] !== ''
    ) {
      $incoming['postgres']['password'] = $stored['postgres']['password'];
    }
    return $incoming;
  }

  /**
   * Remove the password from a decoded backup_config and say whether one is
   * saved. Every schedule the API returns goes through this.
   *
   * @param mixed $config
   * @return mixed
   */
  public static function redactConfig($config)
  {
    if (!is_array($config) || !isset($config['postgres']) || !is_array($config['postgres'])) {
      return $config;
    }
    $hasPassword = isset($config['postgres']['password'])
      && is_string($config['postgres']['password'])
      && $config['postgres']['password'] !== '';
    unset($config['postgres']['password']);
    $config['postgres']['password_set'] = $hasPassword;
    return $config;
  }

  /**
   * Read a variable from a Docker Config.Env list.
   *
   * @param string[] $env
   * @param string[] $names Tried in order
   * @return string|null
   */
  public static function envValue(array $env, array $names)
  {
    foreach ($names as $name) {
      $value = DockerClient::envValue($env, $name);
      if ($value !== '') {
        return $value;
      }
    }
    return null;
  }

  /**
   * Does an inspected container run Postgres? The official image, and every
   * image built on it (postgis, timescale, pgvector, immich), sets PG_MAJOR
   * and PG_VERSION. Bitnami sets BITNAMI_APP_NAME.
   *
   * @param string[] $env
   * @return bool
   */
  public static function envLooksLikePostgres(array $env)
  {
    if (self::envValue($env, ['PG_MAJOR', 'PG_VERSION']) !== null) {
      return true;
    }
    $bitnami = self::envValue($env, ['BITNAMI_APP_NAME']);
    return $bitnami !== null && stripos($bitnami, 'postgres') === 0;
  }

  /**
   * What the form needs to know about a container. Never returns the
   * password itself.
   *
   * @param string $container Container name or id
   * @return array|null Null when the container does not exist
   */
  public function info($container)
  {
    $inspect = $this->docker->inspectContainerRaw($container);
    if (!is_array($inspect)) {
      return null;
    }
    $env = isset($inspect['Config']['Env']) && is_array($inspect['Config']['Env']) ? $inspect['Config']['Env'] : [];
    $user = self::envValue($env, self::USER_ENV);
    $password = self::envValue($env, self::PASSWORD_ENV);

    return [
      'is_postgres' => self::envLooksLikePostgres($env),
      'running' => !empty($inspect['State']['Running']),
      'env_user' => $user !== null && $user !== '' ? $user : 'postgres',
      'has_env_password' => $password !== null && $password !== '',
    ];
  }

  /**
   * The container a Postgres backup runs in, and the prefix its archives use.
   * A stack resolves its service through the compose labels, as backupStack()
   * does, because a compose container is named "<project>-<service>-1".
   *
   * @param string $targetType 'container' or 'stack'
   * @param string $targetId A container name, or a compose project
   * @param string|null $service The compose service, for a stack
   * @return array|null ['id', 'name', 'prefix'], or null when none matches
   */
  public function resolveTarget($targetType, $targetId, $service = null)
  {
    if ($targetType === 'container') {
      // Inspect also answers to an id or an id prefix, so the name must match.
      $inspect = $this->docker->inspectContainerRaw($targetId);
      if (!is_array($inspect) || ltrim($inspect['Name'] ?? '', '/') !== $targetId) {
        return null;
      }
      return ['id' => $inspect['Id'], 'name' => $targetId, 'prefix' => $targetId];
    }

    $found = $this->docker->findContainersByLabels([
      'com.docker.compose.project' => $targetId,
      'com.docker.compose.service' => $service,
    ]);
    if (!$found) {
      return null;
    }
    return ['id' => $found[0]['id'], 'name' => $found[0]['name'], 'prefix' => "{$targetId}.{$service}"];
  }

  /**
   * The user and password to connect with. With 'env', read from the
   * container on every call, so a changed env is picked up. A missing
   * POSTGRES_PASSWORD is not an error: the official image trusts local
   * connections, and pg_dump runs inside the container.
   *
   * @param string $container
   * @param array $pg The postgres block of a backup_config
   * @return array ['user' => string, 'password' => string|null]
   */
  public function resolveCredentials($container, array $pg)
  {
    if (self::credentialsOf($pg) === self::CREDENTIALS_CUSTOM) {
      return [
        'user' => $pg['user'],
        'password' => isset($pg['password']) && is_string($pg['password']) && $pg['password'] !== '' ? $pg['password'] : null,
      ];
    }

    $inspect = $this->docker->inspectContainerRaw($container);
    $env = is_array($inspect) && isset($inspect['Config']['Env']) && is_array($inspect['Config']['Env'])
      ? $inspect['Config']['Env'] : [];
    $user = self::envValue($env, self::USER_ENV);
    $password = self::envValue($env, self::PASSWORD_ENV);
    return [
      'user' => $user !== null && $user !== '' ? $user : 'postgres',
      'password' => $password !== null && $password !== '' ? $password : null,
    ];
  }

  /**
   * List the databases a user can connect to.
   *
   * The official image trusts connections from inside the container, so a
   * wrong password can still succeed here. The caller must not claim the
   * password was checked.
   *
   * @return array ['success' => bool, 'databases' => string[], 'message' => string]
   */
  public function listDatabases($container, $user, $password)
  {
    if (!self::isValidUser($user)) {
      return ['success' => false, 'databases' => [], 'message' => 'Invalid Postgres user'];
    }

    $run = $this->docker->execCapture(
      $container,
      ['psql', '-U', $user, '-d', 'postgres', '-X', '-A', '-t', '-c', self::LIST_DATABASES_SQL],
      self::connectionEnv($password),
      self::QUERY_TIMEOUT
    );

    if (!$run['ok']) {
      return ['success' => false, 'databases' => [], 'message' => self::describeFailure($run, 'psql')];
    }

    $names = [];
    foreach (preg_split('/\r?\n/', $run['stdout']) as $line) {
      if ($line !== '') {
        $names[] = $line;
      }
    }
    return ['success' => true, 'databases' => $names, 'message' => ''];
  }

  /**
   * Dump each database into $stagingDir as 01.dump, 02.dump, ..., with a
   * manifest.json that maps each file to its database.
   *
   * @param string $container
   * @param array $pg The postgres block of a backup_config
   * @param string $stagingDir An existing, empty directory
   * @return array ['success' => bool, 'message' => string]
   */
  public function dumpAll($container, array $pg, $stagingDir)
  {
    $credentials = $this->resolveCredentials($container, $pg);
    if (!self::isValidUser($credentials['user'])) {
      return ['success' => false, 'message' => 'The container env holds an invalid Postgres user'];
    }
    $env = self::connectionEnv($credentials['password']);

    $version = $this->docker->execCapture($container, ['pg_dump', '--version'], [], self::QUERY_TIMEOUT);
    if (!$version['ok']) {
      return ['success' => false, 'message' => self::describeFailure($version, 'pg_dump')];
    }

    $manifest = [
      'format' => 'pg_dump custom (-Fc), restore with pg_restore',
      'container' => $container,
      'user' => $credentials['user'],
      'pg_dump_version' => trim($version['stdout']),
      'created_at' => date('c'),
      'databases' => [],
    ];

    $i = 0;
    foreach ($pg['databases'] as $database) {
      $i++;
      $file = sprintf('%02d.dump', $i);
      $path = rtrim($stagingDir, '/') . '/' . $file;
      $handle = fopen($path, 'wb');
      if ($handle === false) {
        return ['success' => false, 'message' => "Cannot write {$path}"];
      }

      $writeFailed = false;
      $run = $this->docker->execRun(
        $container,
        ['pg_dump', '-U', $credentials['user'], '-Fc', '-d', $database],
        $env,
        function ($payload) use ($handle, &$writeFailed) {
          if (fwrite($handle, $payload) !== strlen($payload)) {
            // Stop the stream now. Reading on would run pg_dump to its end
            // and throw its output away.
            $writeFailed = true;
            return false;
          }
          return true;
        },
        self::DUMP_TIMEOUT
      );
      fclose($handle);

      if ($writeFailed) {
        return ['success' => false, 'message' => "Database {$database}: could not write the dump (disk full?)"];
      }
      if (!$run['ok']) {
        return ['success' => false, 'message' => "Database {$database}: " . self::describeFailure($run, 'pg_dump')];
      }

      $manifest['databases'][] = ['file' => $file, 'database' => $database, 'size' => filesize($path)];
    }

    $written = file_put_contents(
      rtrim($stagingDir, '/') . '/manifest.json',
      json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
    );
    if ($written === false) {
      return ['success' => false, 'message' => 'Cannot write manifest.json'];
    }

    return ['success' => true, 'message' => ''];
  }

  /**
   * @param string|null $password
   * @return string[]
   */
  private static function connectionEnv($password)
  {
    return $password !== null && $password !== '' ? ['PGPASSWORD=' . $password] : [];
  }

  /**
   * Word a failed exec for the user: the first line of stderr, or why the
   * exec itself failed. 126 and 127 are the exit codes for a command that
   * cannot run or does not exist.
   */
  private static function describeFailure(array $run, $tool)
  {
    if ($run['error'] !== '') {
      if (stripos($run['error'], 'is not running') !== false || strpos($run['error'], 'HTTP 409') !== false) {
        return 'The container is not running';
      }
      return $run['error'];
    }
    if ($run['exit_code'] === 126 || $run['exit_code'] === 127) {
      return "{$tool} was not found in the container. Is this a Postgres container?";
    }
    $stderr = trim($run['stderr']);
    if ($stderr !== '') {
      $first = strtok($stderr, "\n");
      return trim($first);
    }
    return "{$tool} exited with code " . $run['exit_code'];
  }
}
