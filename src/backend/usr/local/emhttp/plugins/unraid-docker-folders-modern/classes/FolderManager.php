<?php
/**
 * Unraid Docker Folders - Folder Manager
 *
 * Manages folder operations and container associations
 *
 * @package UnraidDockerModern
 */

require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/ComposeManager.php';

class FolderManager
{
  private $db;

  /**
   * @param Database|null $db Injected for tests; defaults to the singleton.
   */
  public function __construct($db = null)
  {
    $this->db = $db ?? Database::getInstance();
  }

  /**
   * Get all folders with their containers
   *
   * @return array Array of folders with container associations
   */
  public function getAllFolders()
  {
    $sql = 'SELECT * FROM folders ORDER BY position ASC, name ASC';
    $folders = $this->db->fetchAll($sql);

    // Get containers for each folder
    foreach ($folders as &$folder) {
      $folder['containers'] = $this->getFolderContainers($folder['id']);
      $folder['collapsed'] = (bool) $folder['collapsed'];
    }

    return $folders;
  }

  /**
   * Get a single folder by ID
   *
   * @param int $id Folder ID
   * @return array|null Folder data or null if not found
   */
  public function getFolder($id)
  {
    $sql = 'SELECT * FROM folders WHERE id = ?';
    $folder = $this->db->fetchOne($sql, [$id]);

    if (!$folder) {
      return null;
    }

    $folder['containers'] = $this->getFolderContainers($id);
    $folder['collapsed'] = (bool) $folder['collapsed'];

    return $folder;
  }

  /**
   * Create a new folder
   *
   * @param array $data Folder data (name, icon, color, sort_mode)
   * @return array Created folder
   */
  public function createFolder($data)
  {
    $now = time();

    // Get max position
    $maxPosition = $this->db->fetchValue('SELECT MAX(position) FROM folders') ?? -1;

    $folderId = $this->db->insert('folders', [
      'name' => $data['name'] ?? 'New Folder',
      'icon' => $data['icon'] ?? null,
      'color' => $data['color'] ?? null,
      'position' => $maxPosition + 1,
      'collapsed' => 0,
      'compose_project' => $data['compose_project'] ?? null,
      // Unknown or missing modes (e.g. from an import file) fall back to 'manual'.
      'sort_mode' => in_array($data['sort_mode'] ?? null, SORT_MODES, true) ? $data['sort_mode'] : 'manual',
      'created_at' => $now,
      'updated_at' => $now,
    ]);

    return $this->getFolder($folderId);
  }

  /**
   * Update a folder
   *
   * @param int $id Folder ID
   * @param array $data Updated folder data
   * @return array|null Updated folder or null if not found
   */
  public function updateFolder($id, $data)
  {
    $folder = $this->getFolder($id);
    if (!$folder) {
      return null;
    }

    $updates = [
      'updated_at' => time(),
    ];

    if (isset($data['name'])) {
      $updates['name'] = $data['name'];
    }
    if (isset($data['icon'])) {
      $updates['icon'] = $data['icon'];
    }
    if (isset($data['color'])) {
      $updates['color'] = $data['color'];
    }
    if (isset($data['position'])) {
      $updates['position'] = (int) $data['position'];
    }
    if (isset($data['collapsed'])) {
      $updates['collapsed'] = $data['collapsed'] ? 1 : 0;
    }
    if (in_array($data['sort_mode'] ?? null, SORT_MODES, true)) {
      $updates['sort_mode'] = $data['sort_mode'];
    }

    $this->db->update('folders', $updates, 'id = ?', [$id]);

    return $this->getFolder($id);
  }

  /**
   * Delete a folder
   *
   * @param int $id Folder ID
   * @return bool Success
   */
  public function deleteFolder($id)
  {
    // Check if folder exists
    $folder = $this->getFolder($id);
    if (!$folder) {
      return false;
    }

    // Container associations will be deleted by CASCADE
    $this->db->delete('folders', 'id = ?', [$id]);

    return true;
  }

  /**
   * Add a container to a folder
   *
   * @param int $folderId Folder ID
   * @param string $containerId Container ID
   * @param string $containerName Container name
   * @return bool Success
   */
  public function addContainerToFolder($folderId, $containerId, $containerName)
  {
    // Check if folder exists
    $folder = $this->getFolder($folderId);
    if (!$folder) {
      return false;
    }

    // Already in this folder? Keep the row — deleting and reinserting would move
    // it to the end and renumber the folder. Refresh container_id rather than
    // returning early: reorderContainers() matches on container_id, so a stale
    // id would make drag-reorder silently skip this row.
    $existing = $this->db->fetchOne('SELECT folder_id FROM container_folders WHERE container_name = ?', [$containerName]);
    if ($existing && (int) $existing['folder_id'] === (int) $folderId) {
      $this->db->update('container_folders', ['container_id' => $containerId], 'container_name = ?', [$containerName]);
      return true;
    }

    // Get max position in this folder
    $sql = 'SELECT MAX(position) FROM container_folders WHERE folder_id = ?';
    $maxPosition = $this->db->fetchValue($sql, [$folderId]) ?? -1;

    // Remove container from any other folder first (by name, since that's the stable key)
    $this->removeContainerFromFolder($containerName);

    // Add to new folder
    try {
      $this->db->insert('container_folders', [
        'container_id' => $containerId,
        'container_name' => $containerName,
        'folder_id' => $folderId,
        'position' => $maxPosition + 1,
      ]);
      return true;
    } catch (Exception $e) {
      error_log('Error adding container to folder: ' . $e->getMessage());
      return false;
    }
  }

  /**
   * Stop syncComposeStacks from putting a container back into its stack
   * folder. Called when the user removes a container from a folder. It is not
   * part of removeContainerFromFolder, because every move calls that too.
   *
   * @param string $containerName Container name
   */
  public function excludeFromComposeSync($containerName)
  {
    $this->db->query(
      'INSERT OR REPLACE INTO compose_sync_exclusions (container_name, created_at) VALUES (?, ?)',
      [$containerName, time()]
    );
  }

  /**
   * Let syncComposeStacks manage a container again. Called when the user adds a
   * container to a folder.
   *
   * @param string $containerName Container name
   */
  public function clearComposeSyncExclusion($containerName)
  {
    $this->db->delete('compose_sync_exclusions', 'container_name = ?', [$containerName]);
  }

  /**
   * Remove a container from its folder
   *
   * @param string $containerName Container name
   * @return bool Success
   */
  public function removeContainerFromFolder($containerName)
  {
    $this->db->delete('container_folders', 'container_name = ?', [$containerName]);
    return true;
  }

  /**
   * Reconcile container IDs after containers are recreated/updated.
   *
   * Matches existing associations by container_name and updates their
   * container_id to the current value from Docker.
   *
   * @param array $containers List of container data from DockerClient
   * @return void
   */
  public function reconcileContainerIds($containers)
  {
    $associations = $this->db->fetchAll('SELECT id, container_id, container_name FROM container_folders');

    // Build a map of name -> current container id from Docker
    $nameToId = [];
    foreach ($containers as $container) {
      $name = ltrim($container['name'] ?? '', '/');
      if ($name !== '') {
        $nameToId[$name] = $container['id'];
      }
    }

    foreach ($associations as $assoc) {
      $currentId = $nameToId[$assoc['container_name']] ?? null;
      if ($currentId !== null && $currentId !== $assoc['container_id']) {
        $this->db->update(
          'container_folders',
          ['container_id' => $currentId],
          'id = ?',
          [$assoc['id']]
        );
      }
    }
  }

  /**
   * Reorder containers within a folder
   *
   * @param int $folderId Folder ID
   * @param array $containerIds Array of container IDs in new order
   * @return bool Success
   */
  public function reorderContainers($folderId, $containerIds)
  {
    // Check if folder exists
    $folder = $this->getFolder($folderId);
    if (!$folder) {
      return false;
    }

    $this->db->beginTransaction();

    try {
      foreach ($containerIds as $position => $containerId) {
        $this->db->update('container_folders', ['position' => $position], 'folder_id = ? AND container_id = ?', [$folderId, $containerId]);
      }

      $this->db->commit();
      return true;
    } catch (Exception $e) {
      $this->db->rollback();
      error_log('Error reordering containers: ' . $e->getMessage());
      return false;
    }
  }

  /**
   * Reorder folders
   *
   * @param array $folderIds Array of folder IDs in new order
   * @return bool Success
   */
  public function reorderFolders($folderIds)
  {
    $this->db->beginTransaction();

    try {
      foreach ($folderIds as $position => $folderId) {
        $this->db->update('folders', ['position' => $position], 'id = ?', [$folderId]);
      }

      $this->db->commit();
      return true;
    } catch (Exception $e) {
      $this->db->rollback();
      error_log('Error reordering folders: ' . $e->getMessage());
      return false;
    }
  }

  /**
   * Replace the manual order of the containers that are in no folder.
   *
   * Full-replace semantics: the client sends the whole unfoldered list in
   * display order, so any name absent from $containerNames loses its row and
   * gets a new position at the end on the next container-list load
   * (primeUnfolderedOrder). Non-strings, empty strings, and
   * duplicates are skipped; positions stay contiguous from 0.
   *
   * @param array $containerNames Container names in new order
   * @return bool Success
   */
  public function setUnfolderedOrder(array $containerNames)
  {
    $this->db->beginTransaction();

    try {
      $this->db->delete('unfoldered_order', '1 = 1');

      $position = 0;
      $seen = [];
      foreach ($containerNames as $name) {
        // folders.php already rejects non-strings; dedupe matters because
        // container_name is the primary key.
        if ($name === '' || isset($seen[$name])) {
          continue;
        }
        $seen[$name] = true;

        $this->db->insert('unfoldered_order', [
          'container_name' => $name,
          'position' => $position,
        ]);
        $position++;
      }

      $this->db->commit();
      return true;
    } catch (Exception $e) {
      $this->db->rollback();
      error_log('Error reordering unfoldered containers: ' . $e->getMessage());
      return false;
    }
  }

  /**
   * Get the saved manual order of unfoldered containers.
   *
   * @return string[] Container names, first to last
   */
  public function getUnfolderedOrder()
  {
    $rows = $this->db->fetchAll('SELECT container_name FROM unfoldered_order ORDER BY position ASC');
    return array_map(function ($row) {
      return (string) $row['container_name'];
    }, $rows);
  }

  /**
   * Get containers in a folder
   *
   * @param int $folderId Folder ID
   * @return array Array of container associations
   */
  private function getFolderContainers($folderId)
  {
    $sql = 'SELECT * FROM container_folders WHERE folder_id = ? ORDER BY position ASC';
    return $this->db->fetchAll($sql, [$folderId]);
  }

  /**
   * Get folder ID for a container by name
   *
   * @param string $containerName Container name
   * @return int|null Folder ID or null if not in a folder
   */
  public function getContainerFolder($containerName)
  {
    $sql = 'SELECT folder_id FROM container_folders WHERE container_name = ?';
    return $this->db->fetchValue($sql, [$containerName]);
  }

  /**
   * Export folder configuration as JSON
   *
   * @return array Exportable configuration
   */
  public function exportConfiguration()
  {
    $folders = $this->getAllFolders();

    return [
      'version' => '1.0.0',
      'exported_at' => date('c'),
      'folders' => array_map(function ($folder) {
        return [
          'name' => $folder['name'],
          'icon' => $folder['icon'],
          'color' => $folder['color'],
          'position' => $folder['position'],
          'sort_mode' => $folder['sort_mode'] ?? 'manual',
          'containers' => array_map(function ($c) {
            return [
              'id' => $c['container_id'],
              'name' => $c['container_name'],
            ];
          }, $folder['containers']),
        ];
      }, $folders),
    ];
  }

  /**
   * Import folder configuration from JSON
   *
   * @param array $config Configuration data
   * @return array Result with success/error counts
   */
  public function importConfiguration($config)
  {
    $result = [
      'success' => true,
      'folders_created' => 0,
      'containers_assigned' => 0,
      'errors' => [],
    ];

    if (!isset($config['folders']) || !is_array($config['folders'])) {
      $result['success'] = false;
      $result['errors'][] = 'Invalid configuration format';
      return $result;
    }

    $this->db->beginTransaction();

    try {
      foreach ($config['folders'] as $folderData) {
        // Create folder
        $folder = $this->createFolder([
          'name' => $folderData['name'] ?? 'Imported Folder',
          'icon' => $folderData['icon'] ?? null,
          'color' => $folderData['color'] ?? null,
          'sort_mode' => $folderData['sort_mode'] ?? null,
        ]);

        $result['folders_created']++;

        // Add containers
        if (isset($folderData['containers']) && is_array($folderData['containers'])) {
          foreach ($folderData['containers'] as $containerData) {
            if (isset($containerData['id']) && isset($containerData['name'])) {
              $success = $this->addContainerToFolder($folder['id'], $containerData['id'], $containerData['name']);

              if ($success) {
                $result['containers_assigned']++;
              }
            }
          }
        }
      }

      $this->db->commit();
    } catch (Exception $e) {
      $this->db->rollback();
      $result['success'] = false;
      $result['errors'][] = $e->getMessage();
    }

    return $result;
  }

  /**
   * Sync Docker Compose stacks into folders automatically.
   *
   * Groups containers by their com.docker.compose.project label,
   * creates missing folders, and assigns unassigned containers.
   *
   * @param array $containers List of container data from DockerClient
   * @return bool True if any changes were made
   */
  public function syncComposeStacks($containers)
  {
    $changed = false;

    // Group containers by compose project
    $projects = [];
    foreach ($containers as $container) {
      $labels = $container['labels'] ?? [];
      $project = $labels['com.docker.compose.project'] ?? null;
      if ($project === null) {
        continue;
      }
      $projects[$project][] = $container;
    }

    if (empty($projects)) {
      return false;
    }

    // Get existing compose folders keyed by project name
    $existingFolders = $this->db->fetchAll(
      'SELECT * FROM folders WHERE compose_project IS NOT NULL'
    );
    $foldersByProject = [];
    foreach ($existingFolders as $folder) {
      $foldersByProject[$folder['compose_project']] = $folder;
    }

    // Get all current container-folder assignments keyed by container name
    $assignedContainers = $this->db->fetchAll('SELECT container_name, folder_id FROM container_folders');
    $assignmentMap = [];
    foreach ($assignedContainers as $row) {
      $assignmentMap[$row['container_name']] = (int) $row['folder_id'];
    }

    // Containers the user took out of a folder stay out.
    $excluded = [];
    foreach ($this->db->fetchAll('SELECT container_name FROM compose_sync_exclusions') as $row) {
      $excluded[$row['container_name']] = true;
    }

    foreach ($projects as $projectName => $projectContainers) {
      // Upsert compose_stacks metadata from Docker labels
      $firstContainer = $projectContainers[0];
      $labels = $firstContainer['labels'] ?? [];
      $workingDir = $labels['com.docker.compose.project.working_dir'] ?? null;
      $configFiles = $labels['com.docker.compose.project.config_files'] ?? null;
      $composeFile = $configFiles ? explode(',', $configFiles)[0] : null;

      $composeManager = new ComposeManager();
      $composeManager->upsertStack($projectName, $workingDir, $composeFile);

      // Containers that are in no folder and that the user has not taken out of one
      $pending = [];
      foreach ($projectContainers as $container) {
        $containerName = ltrim($container['name'], '/');
        if (!isset($assignmentMap[$containerName]) && !isset($excluded[$containerName])) {
          $pending[] = [$container['id'], $containerName];
        }
      }
      if (empty($pending)) {
        // Every container already has a home, so a stack folder would sit
        // empty, and deleting it would only bring it back on the next sync.
        continue;
      }

      if (!isset($foldersByProject[$projectName])) {
        $folder = $this->createFolder([
          'name' => $projectName,
          'icon' => 'layer-group',
          'compose_project' => $projectName,
        ]);
        $folderId = $folder['id'];
        $changed = true;
      } else {
        $folderId = (int) $foldersByProject[$projectName]['id'];
      }

      foreach ($pending as [$containerId, $containerName]) {
        $this->addContainerToFolder($folderId, $containerId, $containerName);
        $assignmentMap[$containerName] = $folderId;
        $changed = true;
      }
    }

    return $changed;
  }

  /**
   * Give every unfoldered container that has no saved position one.
   *
   * Runs on each container-list load, after syncComposeStacks, so a stack
   * container already sits in its folder. New names go after the saved order,
   * sorted by name. Existing rows are never moved: only a drag reorders them.
   * Without this, a fresh install has no rows and the list falls back to an
   * order that changes whenever a container starts or stops.
   *
   * @param array $containers List of container data from DockerClient
   * @return bool True if any rows were added
   */
  public function primeUnfolderedOrder($containers)
  {
    // Cheap check without the write lock, since this runs on every poll.
    $missing = $this->unorderedNames($containers);
    if (empty($missing)) {
      return false;
    }

    // IMMEDIATE takes the write lock up front, so two loads priming at once
    // queue instead of failing the read-to-write upgrade with SQLITE_BUSY.
    $this->db->exec('BEGIN IMMEDIATE');
    try {
      // Again under the lock: another load may have primed them meanwhile.
      $missing = $this->unorderedNames($containers);
      $position = ($this->db->fetchValue('SELECT MAX(position) FROM unfoldered_order') ?? -1) + 1;
      foreach ($missing as $name) {
        $this->db->insert('unfoldered_order', ['container_name' => $name, 'position' => $position++]);
      }
      $this->db->commit();
      return !empty($missing);
    } catch (Exception $e) {
      $this->db->rollback();
      error_log('Error priming unfoldered order: ' . $e->getMessage());
      return false;
    }
  }

  /**
   * Names of listed containers that are in no folder and have no saved
   * position, in natural name order.
   *
   * @param array $containers List of container data from DockerClient
   * @return string[]
   */
  private function unorderedNames($containers)
  {
    $known = [];
    $rows = $this->db->fetchAll('SELECT container_name FROM container_folders UNION SELECT container_name FROM unfoldered_order');
    foreach ($rows as $row) {
      $known[$row['container_name']] = true;
    }

    $missing = [];
    foreach ($containers as $container) {
      $name = ltrim($container['name'] ?? '', '/');
      if ($name !== '' && !isset($known[$name])) {
        $missing[$name] = true;
      }
    }

    $names = array_keys($missing);
    usort($names, [self::class, 'naturalNameCompare']);
    return $names;
  }

  /**
   * Case-insensitive natural order: digit runs compare by value, everything
   * else byte by byte. Spelled out instead of strnatcasecmp so the GraphQL
   * plugin and the frontend (naturalNameCompare in each) give the same order
   * for names that differ only by punctuation.
   */
  public static function naturalNameCompare($a, $b)
  {
    preg_match_all('/\d+|\D+/', strtolower($a), $ma);
    preg_match_all('/\d+|\D+/', strtolower($b), $mb);
    $ca = $ma[0];
    $cb = $mb[0];
    $n = min(count($ca), count($cb));
    for ($i = 0; $i < $n; $i++) {
      $x = $ca[$i];
      $y = $cb[$i];
      if (ctype_digit($x) && ctype_digit($y)) {
        $x = ltrim($x, '0') ?: '0';
        $y = ltrim($y, '0') ?: '0';
        $cmp = strlen($x) <=> strlen($y) ?: strcmp($x, $y) <=> 0;
      } else {
        $cmp = strcmp($x, $y) <=> 0;
      }
      if ($cmp !== 0) {
        return $cmp;
      }
    }
    return count($ca) <=> count($cb) ?: strcmp($a, $b) <=> 0;
  }

  /**
   * Remove a container from all folders by name.
   * Called when a container is deleted from Docker.
   */
  public function removeContainerByName($containerName)
  {
    $this->db->delete('container_folders', 'container_name = ?', [$containerName]);
    $this->db->delete('unfoldered_order', 'container_name = ?', [$containerName]);
  }

  /**
   * Get statistics
   *
   * @return array Folder statistics
   */
  public function getStatistics()
  {
    return [
      'total_folders' => $this->db->getRowCount('folders'),
      'total_assigned_containers' => $this->db->getRowCount('container_folders'),
    ];
  }
}
