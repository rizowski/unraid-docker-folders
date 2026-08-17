<?php
/**
 * Unraid Docker Folders - Release Notes
 *
 * Fetches and normalises the latest GitHub release for an image, so the
 * update confirm modal can show what a pull will bring in.
 *
 * Deliberately NOT part of DockerClient: every curl handle there sets
 * CURLOPT_UNIX_SOCKET_PATH and talks only to the local daemon. This is the
 * one place in the plugin (besides the compose binary download) that reaches
 * the public internet, and keeping that separation explicit is the point.
 *
 * @package UnraidDockerModern
 */

class ReleaseNotes
{
  /** GitHub REST API root */
  const API_BASE = 'https://api.github.com';

  /** GitHub 403s any request that arrives without a User-Agent */
  const USER_AGENT = 'unraid-docker-folders-modern';

  /**
   * Short timeouts on purpose. ComposeManager::installComposeBinary() uses
   * 10/120 because it pulls a 60MB binary; this pulls ~4KB of JSON, and an
   * air-gapped server must not stall the update check waiting on DNS.
   */
  const CONNECT_TIMEOUT = 3;
  const TIMEOUT = 5;

  /** Release bodies can be enormous; the modal row shows one line. */
  const SUMMARY_MAX_CHARS = 400;

  /** How long a cached row stays valid, per status. */
  const TTL_OK = 86400;        // 24h
  const TTL_NOT_FOUND = 604800; // 7d  - repo has no Releases, don't keep asking
  const TTL_ERROR = 21600;      // 6h  - transient network/5xx

  /**
   * Unauthenticated GitHub allows 60 requests/hour/IP. Cron runs at most
   * hourly, so this caps the worst case at a third of the budget.
   *
   * No github_token setting exists, and adding one is not a small change:
   * api/settings.php handleGet returns the entire settings table to the
   * iframe, so a token would be shipped into the page on every load. That
   * would have to be filtered first.
   */
  const MAX_FETCHES_PER_RUN = 20;

  /** Total wall-clock budget for a run's fetches, so 20 timeouts can't add 100s. */
  const MAX_WALL_SECONDS = 30;

  /**
   * Parse a GitHub "owner/name" out of an org.opencontainers.image.source URL.
   *
   * This is the only place host parsing lives. The label is validated upstream
   * as ^https?:// but says nothing about the host, so GitLab/Gitea/docs sites
   * all show up here. Those return null: they get no source_repo, no cache row
   * (no point burning negative-cache entries on hosts we never support), and
   * fall through to the existing "${source_url}/releases" link-out.
   *
   * @param string|null $sourceUrl
   * @return string|null Lowercased "owner/name", or null when not GitHub
   */
  public static function parseRepo($sourceUrl)
  {
    if (!is_string($sourceUrl) || $sourceUrl === '') {
      return null;
    }

    $parts = @parse_url($sourceUrl);
    if (!is_array($parts) || empty($parts['host']) || empty($parts['path'])) {
      return null;
    }

    $scheme = strtolower($parts['scheme'] ?? '');
    if ($scheme !== 'http' && $scheme !== 'https') {
      return null;
    }

    $host = strtolower($parts['host']);
    if ($host !== 'github.com' && $host !== 'www.github.com') {
      return null;
    }

    // Keep the first two segments; ignore /tree/main, /blob/..., etc.
    $segments = array_values(array_filter(explode('/', $parts['path']), function ($s) {
      return $s !== '';
    }));
    if (count($segments) < 2) {
      return null;
    }

    $owner = $segments[0];
    $name = preg_replace('/\.git$/i', '', $segments[1]);

    if (!preg_match('/^[A-Za-z0-9._-]+$/', $owner) || !preg_match('/^[A-Za-z0-9._-]+$/', $name)) {
      return null;
    }

    return strtolower($owner . '/' . $name);
  }

  /**
   * How long a row with the given status stays fresh.
   *
   * @param string|null $status
   * @return int Seconds
   */
  public static function ttlFor($status)
  {
    switch ($status) {
      case 'not_found':
        return self::TTL_NOT_FOUND;
      case 'error':
        return self::TTL_ERROR;
      default:
        return self::TTL_OK;
    }
  }

  /**
   * Fetch the latest release for a repo.
   *
   * @param string $repo "owner/name"
   * @return array ['status' => 'ok'|'not_found'|'error'|'rate_limited', 'http' => int, 'release' => array|null]
   */
  public static function fetchLatest($repo)
  {
    $url = self::API_BASE . '/repos/' . $repo . '/releases/latest';

    $rateRemaining = null;

    $ch = curl_init($url);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_FOLLOWLOCATION => true,
      CURLOPT_MAXREDIRS => 3,
      CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT,
      CURLOPT_TIMEOUT => self::TIMEOUT,
      CURLOPT_USERAGENT => self::USER_AGENT,
      // Deliberately NOT setting CURLOPT_FAILONERROR (unlike ComposeManager):
      // we need the status code to tell a 404 from a 403 rate-limit.
      CURLOPT_HTTPHEADER => [
        'Accept: application/vnd.github+json',
        'X-GitHub-Api-Version: 2022-11-28',
      ],
      CURLOPT_HEADERFUNCTION => function ($handle, $header) use (&$rateRemaining) {
        if (stripos($header, 'x-ratelimit-remaining:') === 0) {
          $rateRemaining = (int) trim(substr($header, strlen('x-ratelimit-remaining:')));
        }
        return strlen($header);
      },
    ]);

    $body = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($body === false || $httpCode === 0) {
      return ['status' => 'error', 'http' => $httpCode, 'release' => null];
    }

    if ($httpCode === 404) {
      return ['status' => 'not_found', 'http' => 404, 'release' => null];
    }

    // 403/429 with the budget exhausted means back off entirely; the caller
    // aborts the run rather than writing rows that would poison the cache.
    if ($httpCode === 429 || ($httpCode === 403 && $rateRemaining === 0)) {
      return ['status' => 'rate_limited', 'http' => $httpCode, 'release' => null];
    }

    if ($httpCode >= 400) {
      return ['status' => 'error', 'http' => $httpCode, 'release' => null];
    }

    $data = json_decode($body, true);
    if (!is_array($data)) {
      return ['status' => 'error', 'http' => $httpCode, 'release' => null];
    }

    $publishedAt = null;
    if (!empty($data['published_at'])) {
      $ts = strtotime($data['published_at']);
      $publishedAt = $ts === false ? null : $ts;
    }

    return [
      'status' => 'ok',
      'http' => $httpCode,
      'release' => [
        'tag' => $data['tag_name'] ?? null,
        'name' => $data['name'] ?? null,
        'published_at' => $publishedAt,
        'url' => $data['html_url'] ?? null,
        'summary' => self::toPlainText($data['body'] ?? ''),
      ],
    ];
  }

  /**
   * Flatten release markdown to a single line of plain text.
   *
   * Runs at write time so the raw body is never persisted and never crosses
   * postMessage. In the iframe the summary is rendered into the *parent*
   * Unraid document, so a markup-bearing string there would be an XSS vector
   * into the webgui, not just into our own frame.
   *
   * @param string $markdown
   * @return string
   */
  public static function toPlainText($markdown)
  {
    if (!is_string($markdown) || $markdown === '') {
      return '';
    }

    $text = str_replace(["\r\n", "\r"], "\n", $markdown);

    // Fenced code blocks and HTML comments carry no summary value.
    $text = preg_replace('/```.*?```/s', ' ', $text);
    $text = preg_replace('/~~~.*?~~~/s', ' ', $text);
    $text = preg_replace('/<!--.*?-->/s', ' ', $text);

    // Note: this also eats prose like "<0.5", which is acceptable for a
    // one-line preview and cheaper than a real HTML parser.
    $text = strip_tags($text);

    $text = preg_replace('/!\[[^\]]*\]\([^)]*\)/', ' ', $text);   // images
    $text = preg_replace('/\[([^\]]*)\]\([^)]*\)/', '$1', $text); // links -> text
    $text = preg_replace('/<(https?:\/\/[^>]+)>/', '$1', $text);  // autolinks

    // Line-leading markers: headings, quotes, bullets, ordered list numbers.
    $text = preg_replace('/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/m', '', $text);

    $text = str_replace(['**', '__', '`'], '', $text);
    // Single-character emphasis, opening and closing. Anchored so snake_case
    // identifiers and a bare "*" in prose survive.
    $text = preg_replace('/(?<!\w)[*_](?=\S)/', '', $text);
    $text = preg_replace('/(?<=\S)[*_](?!\w)/', '', $text);

    $text = preg_replace('/\s+/', ' ', $text);
    $text = trim($text);

    return self::truncate($text, self::SUMMARY_MAX_CHARS);
  }

  /**
   * @param string $text
   * @param int $cap
   * @return string
   */
  private static function truncate($text, $cap)
  {
    $cap = (int) $cap;
    if ($cap <= 0) {
      return '';
    }

    if (function_exists('mb_strlen')) {
      if (mb_strlen($text, 'UTF-8') <= $cap) {
        return $text;
      }
      return rtrim(mb_substr($text, 0, $cap, 'UTF-8')) . '…';
    }

    if (strlen($text) <= $cap) {
      return $text;
    }
    return rtrim(substr($text, 0, $cap)) . '…';
  }

  /**
   * Shape a release_notes row into the JSON object the frontend consumes.
   *
   * @param array|null $row
   * @return array|null Null unless the row is a successful fetch
   */
  public static function payload($row)
  {
    if (!is_array($row) || ($row['status'] ?? null) !== 'ok') {
      return null;
    }

    return [
      'tag' => $row['tag'] ?? null,
      'name' => $row['name'] ?? null,
      'published_at' => isset($row['published_at']) && $row['published_at'] !== null
        ? (int) $row['published_at']
        : null,
      'url' => $row['url'] ?? null,
      'summary' => (string) ($row['summary'] ?? ''),
      'fetched_at' => (int) ($row['fetched_at'] ?? 0),
    ];
  }
}
