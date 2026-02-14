<?php
/**
 * Unraid Docker Modern - Database Migration Runner
 *
 * Executes SQL migrations to create/update database schema
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';

/**
 * Run database migrations
 */
function runMigrations() {
    echo "Starting database migrations...\n";

    try {
        $db = Database::getInstance();
    } catch (Exception $e) {
        echo "Error: Failed to initialize database: " . $e->getMessage() . "\n";
        echo "Database path: " . DB_PATH . "\n";
        return false;
    }

    $migrationsDir = dirname(__DIR__) . '/migrations';

    // Ensure migrations directory exists
    if (!is_dir($migrationsDir)) {
        echo "Error: Migrations directory not found: $migrationsDir\n";
        return false;
    }

    // Create migrations tracking table if it doesn't exist
    try {
        $db->query("
            CREATE TABLE IF NOT EXISTS migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL UNIQUE,
                executed_at INTEGER NOT NULL
            )
        ");
    } catch (Exception $e) {
        echo "Error: Failed to create migrations table: " . $e->getMessage() . "\n";
        return false;
    }

    // Get list of migration files
    $files = glob($migrationsDir . '/*.sql');
    if ($files === false) {
        echo "Error: Failed to read migrations directory\n";
        return false;
    }

    sort($files);

    if (empty($files)) {
        echo "No migration files found.\n";
        return true;
    }

    echo "Found " . count($files) . " migration file(s)\n";

    // Get already executed migrations
    $executed = [];
    try {
        $result = $db->fetchAll("SELECT filename FROM migrations");
        foreach ($result as $row) {
            $executed[] = $row['filename'];
        }

        if (!empty($executed)) {
            echo "Already executed: " . count($executed) . " migration(s)\n";
        }
    } catch (Exception $e) {
        echo "Warning: Could not read migrations table: " . $e->getMessage() . "\n";
        echo "Assuming fresh database...\n";
        $executed = [];
    }

    // Execute pending migrations
    $count = 0;
    foreach ($files as $file) {
        $filename = basename($file);

        if (in_array($filename, $executed)) {
            echo "  [SKIP] $filename (already executed)\n";
            continue;
        }

        echo "  [RUN]  $filename\n";

        // Read SQL file
        $sql = file_get_contents($file);
        if ($sql === false) {
            echo "Error: Could not read migration file: $file\n";
            return false;
        }

        // Execute migration
        try {
            $db->beginTransaction();

            // Execute SQL statements
            $db->exec($sql);

            // Record migration
            $db->insert('migrations', [
                'filename' => $filename,
                'executed_at' => time()
            ]);

            $db->commit();

            echo "  [OK]   $filename executed successfully\n";
            $count++;

        } catch (Exception $e) {
            $db->rollback();
            echo "Error executing migration $filename: " . $e->getMessage() . "\n";
            echo "SQL Error Code: " . $e->getCode() . "\n";

            // Try to provide helpful context
            if (file_exists(DB_PATH)) {
                echo "Database file exists at: " . DB_PATH . "\n";
                echo "Database file size: " . filesize(DB_PATH) . " bytes\n";
                echo "Database file permissions: " . substr(sprintf('%o', fileperms(DB_PATH)), -4) . "\n";
            } else {
                echo "Database file does not exist at: " . DB_PATH . "\n";
            }

            return false;
        }
    }

    if ($count === 0) {
        echo "All migrations are up to date.\n";
    } else {
        echo "\n$count migration(s) executed successfully.\n";
    }

    // Display database info
    displayDatabaseInfo($db);

    return true;
}

/**
 * Display database information
 */
function displayDatabaseInfo($db) {
    echo "\nDatabase Information:\n";
    echo "  Path: " . DB_PATH . "\n";
    echo "  Size: " . formatBytes($db->getSize()) . "\n";

    $tables = ['folders', 'container_folders', 'settings', 'container_cache'];
    foreach ($tables as $table) {
        if ($db->tableExists($table)) {
            $count = $db->getRowCount($table);
            echo "  Table '$table': $count rows\n";
        }
    }
}

/**
 * Format bytes to human readable string
 */
function formatBytes($bytes, $precision = 2) {
    $units = ['B', 'KB', 'MB', 'GB'];
    $bytes = max($bytes, 0);
    $pow = floor(($bytes ? log($bytes) : 0) / log(1024));
    $pow = min($pow, count($units) - 1);
    $bytes /= pow(1024, $pow);
    return round($bytes, $precision) . ' ' . $units[$pow];
}

// Run migrations if executed directly
if (php_sapi_name() === 'cli' || basename($_SERVER['PHP_SELF']) === 'migrate.php') {
    $success = runMigrations();
    exit($success ? 0 : 1);
}
