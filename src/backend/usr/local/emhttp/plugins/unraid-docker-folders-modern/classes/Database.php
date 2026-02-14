<?php
/**
 * Unraid Docker Modern - Database Class
 *
 * PDO wrapper for SQLite database operations
 *
 * @package UnraidDockerModern
 */

class Database {
    private static $instance = null;
    private $pdo;
    private $dbPath;

    /**
     * Private constructor (Singleton pattern)
     */
    private function __construct($dbPath = DB_PATH) {
        $this->dbPath = $dbPath;
        $this->connect();
    }

    /**
     * Get Database instance (Singleton)
     *
     * @return Database
     */
    public static function getInstance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    /**
     * Connect to SQLite database
     */
    private function connect() {
        try {
            // Ensure directory exists
            $dir = dirname($this->dbPath);
            if (!is_dir($dir)) {
                mkdir($dir, 0755, true);
            }

            // Connect to database
            $this->pdo = new PDO('sqlite:' . $this->dbPath);
            $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

            // Enable foreign keys
            $this->pdo->exec('PRAGMA foreign_keys = ON');

            // Set journal mode to WAL for better concurrency
            $this->pdo->exec('PRAGMA journal_mode = WAL');

        } catch (PDOException $e) {
            error_log('Database connection error: ' . $e->getMessage());
            throw $e;
        }
    }

    /**
     * Get PDO instance
     *
     * @return PDO
     */
    public function getPdo() {
        return $this->pdo;
    }

    /**
     * Execute a query
     *
     * @param string $sql SQL query
     * @param array $params Parameters
     * @return PDOStatement
     */
    public function query($sql, $params = []) {
        try {
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute($params);
            return $stmt;
        } catch (PDOException $e) {
            error_log('Database query error: ' . $e->getMessage());
            error_log('SQL: ' . $sql);
            throw $e;
        }
    }

    /**
     * Fetch all rows
     *
     * @param string $sql SQL query
     * @param array $params Parameters
     * @return array
     */
    public function fetchAll($sql, $params = []) {
        $stmt = $this->query($sql, $params);
        return $stmt->fetchAll();
    }

    /**
     * Fetch single row
     *
     * @param string $sql SQL query
     * @param array $params Parameters
     * @return array|false
     */
    public function fetchOne($sql, $params = []) {
        $stmt = $this->query($sql, $params);
        return $stmt->fetch();
    }

    /**
     * Fetch single value
     *
     * @param string $sql SQL query
     * @param array $params Parameters
     * @return mixed
     */
    public function fetchValue($sql, $params = []) {
        $stmt = $this->query($sql, $params);
        return $stmt->fetchColumn();
    }

    /**
     * Insert row and return last insert ID
     *
     * @param string $table Table name
     * @param array $data Associative array of column => value
     * @return int Last insert ID
     */
    public function insert($table, $data) {
        $columns = array_keys($data);
        $placeholders = array_fill(0, count($columns), '?');

        $sql = sprintf(
            'INSERT INTO %s (%s) VALUES (%s)',
            $table,
            implode(', ', $columns),
            implode(', ', $placeholders)
        );

        $this->query($sql, array_values($data));
        return $this->pdo->lastInsertId();
    }

    /**
     * Update rows
     *
     * @param string $table Table name
     * @param array $data Associative array of column => value
     * @param string $where WHERE clause
     * @param array $whereParams WHERE parameters
     * @return int Number of affected rows
     */
    public function update($table, $data, $where, $whereParams = []) {
        $sets = [];
        foreach (array_keys($data) as $column) {
            $sets[] = "$column = ?";
        }

        $sql = sprintf(
            'UPDATE %s SET %s WHERE %s',
            $table,
            implode(', ', $sets),
            $where
        );

        $params = array_merge(array_values($data), $whereParams);
        $stmt = $this->query($sql, $params);
        return $stmt->rowCount();
    }

    /**
     * Delete rows
     *
     * @param string $table Table name
     * @param string $where WHERE clause
     * @param array $params WHERE parameters
     * @return int Number of affected rows
     */
    public function delete($table, $where, $params = []) {
        $sql = sprintf('DELETE FROM %s WHERE %s', $table, $where);
        $stmt = $this->query($sql, $params);
        return $stmt->rowCount();
    }

    /**
     * Begin transaction
     */
    public function beginTransaction() {
        $this->pdo->beginTransaction();
    }

    /**
     * Commit transaction
     */
    public function commit() {
        $this->pdo->commit();
    }

    /**
     * Rollback transaction
     */
    public function rollback() {
        $this->pdo->rollBack();
    }

    /**
     * Check if table exists
     *
     * @param string $table Table name
     * @return bool
     */
    public function tableExists($table) {
        $sql = "SELECT name FROM sqlite_master WHERE type='table' AND name=?";
        $result = $this->fetchValue($sql, [$table]);
        return $result !== false;
    }

    /**
     * Get database file size in bytes
     *
     * @return int
     */
    public function getSize() {
        if (file_exists($this->dbPath)) {
            return filesize($this->dbPath);
        }
        return 0;
    }

    /**
     * Vacuum database (optimize and reclaim space)
     */
    public function vacuum() {
        $this->pdo->exec('VACUUM');
    }

    /**
     * Get table row count
     *
     * @param string $table Table name
     * @return int
     */
    public function getRowCount($table) {
        $sql = "SELECT COUNT(*) FROM $table";
        return (int) $this->fetchValue($sql);
    }
}
