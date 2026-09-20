<?php
/**
 * Unraid Docker Folders - Security Advisor
 *
 * Stores the security findings a user accepted on purpose. The findings
 * themselves are derived in the frontend (utils/securityFindings.ts) from
 * fields the container list already carries; only the dismissals need to
 * outlive a page load, and they are keyed by container name because container
 * IDs change on every recreate.
 *
 * @package UnraidDockerModern
 */

require_once __DIR__ . '/Database.php';

class SecurityAdvisor
{
  /**
   * The finding types the frontend can produce. Kept here as the write-side
   * allowlist so an unknown type cannot reach the table and silently disable a
   * finding nobody can restore.
   *
   * This list is the `FindingType` union in
   * src/frontend/src/utils/securityFindings.ts, spelled a second time because
   * PHP and TypeScript share no source. Add a finding type to both, or a
   * dismissal of the new type comes back as a 400. SecurityAdvisorTest and
   * securityFindings.spec.ts each assert the full list, so a one-sided edit
   * fails a test instead of shipping.
   */
  const FINDING_TYPES = [
    'privileged',
    'docker-socket',
    'host-network',
    'added-capabilities',
    'broad-mount',
    'forced-root',
    'shared-mount-group',
  ];

  private $db;

  /**
   * @param Database|null $db Injected for tests; defaults to the singleton.
   */
  public function __construct($db = null)
  {
    $this->db = $db ?? Database::getInstance();
  }

  /**
   * Every dismissal, for the container list response.
   *
   * @return array List of {container_name, finding_type}
   */
  public function listDismissals()
  {
    return $this->db->fetchAll(
      'SELECT container_name, finding_type FROM security_dismissals ORDER BY container_name, finding_type'
    );
  }

  /**
   * Accept a finding. Idempotent.
   *
   * @param string $containerName
   * @param string $findingType
   * @throws InvalidArgumentException on an empty name or unknown type
   */
  public function dismiss($containerName, $findingType)
  {
    $this->validate($containerName, $findingType);

    $this->db->query(
      'INSERT OR REPLACE INTO security_dismissals (container_name, finding_type, created_at) VALUES (?, ?, ?)',
      [$containerName, $findingType, time()]
    );
  }

  /**
   * Show a dismissed finding again. Idempotent.
   *
   * @param string $containerName
   * @param string $findingType
   * @throws InvalidArgumentException on an empty name or unknown type
   */
  public function restore($containerName, $findingType)
  {
    $this->validate($containerName, $findingType);

    $this->db->delete(
      'security_dismissals',
      'container_name = ? AND finding_type = ?',
      [$containerName, $findingType]
    );
  }

  /**
   * @param string $containerName
   * @param string $findingType
   * @throws InvalidArgumentException
   */
  private function validate($containerName, $findingType)
  {
    if (!is_string($containerName) || trim($containerName) === '') {
      throw new InvalidArgumentException('container_name is required');
    }

    if (!in_array($findingType, self::FINDING_TYPES, true)) {
      throw new InvalidArgumentException('Unknown finding type');
    }
  }
}
