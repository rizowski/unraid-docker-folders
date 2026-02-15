<?php
/**
 * Unraid Docker Folders - Database Class
 *
 * SQLite3 wrapper for database operations
 * Uses native SQLite3 extension instead of PDO for better compatibility
 *
 * @package UnraidDockerModern
 */

class Database
{
  private static $instance = null;
  private $db;
  private $dbPath;

  /**
   * Private constructor (Singleton pattern)
   */
  private function __construct($dbPath = DB_PATH)
  {
    $this->dbPath = $dbPath;
    $this->connect();
  }

  /**
   * Get Database instance (Singleton)
   *
   * @return Database
   */
  public static function getInstance()
  {
    if (self::$instance === null) {
      self::$instance = new self();
    }
    return self::$instance;
  }

  /**
   * Connect to SQLite database
   */
  private function connect()
  {
    // Check if SQLite3 extension is available
    if (!class_exists('SQLite3')) {
      throw new Exception('SQLite3 extension is not available. Please install php-sqlite3.');
    }

    try {
      // Ensure directory exists
      $dir = dirname($this->dbPath);
      if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
      }

      // Connect to database
      $this->db = new SQLite3($this->dbPath);
      $this->db->busyTimeout(5000); // 5 second timeout

      // Enable foreign keys
      $this->db->exec('PRAGMA foreign_keys = ON');

      // Set journal mode to WAL for better concurrency
      $this->db->exec('PRAGMA journal_mode = WAL');
    } catch (Exception $e) {
      error_log('Database connection error: ' . $e->getMessage());
      throw $e;
    }
  }

  /**
   * Get SQLite3 instance (for direct access if needed)
   *
   * @return SQLite3
   */
  public function getDb()
  {
    return $this->db;
  }

  /**
   * Backwards compatibility - return self for PDO-style calls
   */
  public function getPdo()
  {
    return $this;
  }

  /**
   * Execute a query
   *
   * @param string $sql SQL query
   * @param array $params Parameters
   * @return SQLite3Result|bool
   */
  public function query($sql, $params = [])
  {
    try {
      $stmt = $this->db->prepare($sql);

      if ($stmt === false) {
        throw new Exception('Failed to prepare statement: ' . $this->db->lastErrorMsg());
      }

      // Bind parameters
      foreach ($params as $i => $value) {
        $index = is_int($i) ? $i + 1 : $i;
        $type = $this->getSQLite3Type($value);
        $stmt->bindValue($index, $value, $type);
      }

      $result = $stmt->execute();

      if ($result === false) {
        throw new Exception('Query execution failed: ' . $this->db->lastErrorMsg());
      }

      return $result;
    } catch (Exception $e) {
      error_log('Database query error: ' . $e->getMessage());
      error_log('SQL: ' . $sql);
      throw $e;
    }
  }

  /**
   * Execute a statement (for non-SELECT queries like CREATE, INSERT, etc.)
   *
   * @param string $sql SQL query
   * @return bool
   */
  public function exec($sql)
  {
    $result = $this->db->exec($sql);
    if ($result === false) {
      throw new Exception('Exec failed: ' . $this->db->lastErrorMsg());
    }
    return $result;
  }

  /**
   * Fetch all rows
   *
   * @param string $sql SQL query
   * @param array $params Parameters
   * @return array
   */
  public function fetchAll($sql, $params = [])
  {
    $result = $this->query($sql, $params);
    $rows = [];

    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
      $rows[] = $row;
    }

    return $rows;
  }

  /**
   * Fetch single row
   *
   * @param string $sql SQL query
   * @param array $params Parameters
   * @return array|false
   */
  public function fetchOne($sql, $params = [])
  {
    $result = $this->query($sql, $params);
    return $result->fetchArray(SQLITE3_ASSOC);
  }

  /**
   * Fetch single value
   *
   * @param string $sql SQL query
   * @param array $params Parameters
   * @return mixed
   */
  public function fetchValue($sql, $params = [])
  {
    $result = $this->query($sql, $params);
    $row = $result->fetchArray(SQLITE3_NUM);
    return $row ? $row[0] : false;
  }

  /**
   * Insert row and return last insert ID
   *
   * @param string $table Table name
   * @param array $data Associative array of column => value
   * @return int Last insert ID
   */
  public function insert($table, $data)
  {
    $columns = array_keys($data);
    $placeholders = array_fill(0, count($columns), '?');

    $sql = sprintf('INSERT INTO %s (%s) VALUES (%s)', $table, implode(', ', $columns), implode(', ', $placeholders));

    $this->query($sql, array_values($data));
    return $this->db->lastInsertRowID();
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
  public function update($table, $data, $where, $whereParams = [])
  {
    $sets = [];
    foreach (array_keys($data) as $column) {
      $sets[] = "$column = ?";
    }

    $sql = sprintf('UPDATE %s SET %s WHERE %s', $table, implode(', ', $sets), $where);

    $params = array_merge(array_values($data), $whereParams);
    $this->query($sql, $params);
    return $this->db->changes();
  }

  /**
   * Delete rows
   *
   * @param string $table Table name
   * @param string $where WHERE clause
   * @param array $params WHERE parameters
   * @return int Number of affected rows
   */
  public function delete($table, $where, $params = [])
  {
    $sql = sprintf('DELETE FROM %s WHERE %s', $table, $where);
    $this->query($sql, $params);
    return $this->db->changes();
  }

  /**
   * Begin transaction
   */
  public function beginTransaction()
  {
    $this->db->exec('BEGIN TRANSACTION');
  }

  /**
   * Commit transaction
   */
  public function commit()
  {
    $this->db->exec('COMMIT');
  }

  /**
   * Rollback transaction
   */
  public function rollback()
  {
    $this->db->exec('ROLLBACK');
  }

  /**
   * Check if table exists
   *
   * @param string $table Table name
   * @return bool
   */
  public function tableExists($table)
  {
    $sql = "SELECT name FROM sqlite_master WHERE type='table' AND name=?";
    $result = $this->fetchValue($sql, [$table]);
    return $result !== false;
  }

  /**
   * Get database file size in bytes
   *
   * @return int
   */
  public function getSize()
  {
    if (file_exists($this->dbPath)) {
      return filesize($this->dbPath);
    }
    return 0;
  }

  /**
   * Vacuum database (optimize and reclaim space)
   */
  public function vacuum()
  {
    $this->db->exec('VACUUM');
  }

  /**
   * Get table row count
   *
   * @param string $table Table name
   * @return int
   */
  public function getRowCount($table)
  {
    $sql = "SELECT COUNT(*) FROM $table";
    return (int) $this->fetchValue($sql);
  }

  /**
   * Get SQLite3 type constant for a value
   *
   * @param mixed $value
   * @return int SQLite3 type constant
   */
  private function getSQLite3Type($value)
  {
    if (is_int($value)) {
      return SQLITE3_INTEGER;
    } elseif (is_float($value)) {
      return SQLITE3_FLOAT;
    } elseif (is_null($value)) {
      return SQLITE3_NULL;
    } else {
      return SQLITE3_TEXT;
    }
  }

  /**
   * Close database connection
   */
  public function close()
  {
    if ($this->db) {
      $this->db->close();
    }
  }

  /**
   * Destructor - close connection
   */
  public function __destruct()
  {
    $this->close();
  }
}
