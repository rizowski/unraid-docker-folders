<?php
/**
 * Unraid Docker Modern - Folder Manager
 *
 * Manages folder operations and container associations
 *
 * @package UnraidDockerModern
 */

require_once __DIR__ . '/Database.php';

class FolderManager
{
    private $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
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
     * @param array $data Folder data (name, icon, color)
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

        // Get max position in this folder
        $sql = 'SELECT MAX(position) FROM container_folders WHERE folder_id = ?';
        $maxPosition = $this->db->fetchValue($sql, [$folderId]) ?? -1;

        // Remove container from any other folder first
        $this->removeContainerFromFolder($containerId);

        // Add to new folder
        try {
            $this->db->insert('container_folders', [
                'container_id' => $containerId,
                'container_name' => $containerName,
                'folder_id' => $folderId,
                'position' => $maxPosition + 1,
            ]);
            return true;
        } catch (PDOException $e) {
            error_log('Error adding container to folder: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * Remove a container from its folder
     *
     * @param string $containerId Container ID
     * @return bool Success
     */
    public function removeContainerFromFolder($containerId)
    {
        $this->db->delete('container_folders', 'container_id = ?', [$containerId]);
        return true;
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
                $this->db->update(
                    'container_folders',
                    ['position' => $position],
                    'folder_id = ? AND container_id = ?',
                    [$folderId, $containerId]
                );
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
                $this->db->update(
                    'folders',
                    ['position' => $position],
                    'id = ?',
                    [$folderId]
                );
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
     * Get folder ID for a container
     *
     * @param string $containerId Container ID
     * @return int|null Folder ID or null if not in a folder
     */
    public function getContainerFolder($containerId)
    {
        $sql = 'SELECT folder_id FROM container_folders WHERE container_id = ?';
        return $this->db->fetchValue($sql, [$containerId]);
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
                ]);

                $result['folders_created']++;

                // Add containers
                if (isset($folderData['containers']) && is_array($folderData['containers'])) {
                    foreach ($folderData['containers'] as $containerData) {
                        if (isset($containerData['id']) && isset($containerData['name'])) {
                            $success = $this->addContainerToFolder(
                                $folder['id'],
                                $containerData['id'],
                                $containerData['name']
                            );

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
