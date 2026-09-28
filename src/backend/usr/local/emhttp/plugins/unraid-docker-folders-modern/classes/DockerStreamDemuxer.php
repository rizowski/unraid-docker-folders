<?php
/**
 * Unraid Docker Folders - Docker stream demuxer
 *
 * Splits the multiplexed stream that Docker sends for an exec without a TTY.
 * Each frame has an 8-byte header: byte 0 is the stream (1 stdout, 2 stderr),
 * bytes 4-7 are the payload length as a big-endian integer. curl hands the
 * body over in chunks of any size, so a header or a payload can span chunks.
 *
 * A TTY exec would send plain bytes, but a TTY turns "\n" into "\r\n", and
 * that corrupts a binary pg_dump archive. So exec always runs without one.
 *
 * Kept apart from DockerClient so the suite can test it without a socket.
 *
 * @package UnraidDockerModern
 */

class DockerStreamDemuxer
{
  const STDOUT = 1;
  const STDERR = 2;

  private $buffer = '';
  private $onStdout;
  private $onStderr;

  /**
   * @param callable $onStdout Receives each stdout payload as a string, and
   *   returns false to stop the stream, for example when the disk is full
   * @param callable $onStderr Receives each stderr payload as a string
   */
  public function __construct(callable $onStdout, callable $onStderr)
  {
    $this->onStdout = $onStdout;
    $this->onStderr = $onStderr;
  }

  /**
   * Feed one chunk of the body. Returns the chunk length, as curl's
   * CURLOPT_WRITEFUNCTION expects, or 0 when $onStdout asked to stop, which
   * makes curl abort the transfer. Closing the stream ends the command in
   * the container, because its next write fails.
   *
   * @param string $chunk
   * @return int
   */
  public function feed($chunk)
  {
    $this->buffer .= $chunk;
    $size = strlen($this->buffer);

    // Walk the frames by offset and trim the buffer once at the end. Trimming
    // per frame would copy the rest of the buffer for every small frame.
    $pos = 0;
    while ($size - $pos >= 8) {
      $header = unpack('Cstream/x3/Nlength', $this->buffer, $pos);
      $length = $header['length'];
      if ($size - $pos < 8 + $length) {
        break;
      }

      $payload = (string) substr($this->buffer, $pos + 8, $length);
      $pos += 8 + $length;

      if ($header['stream'] === self::STDERR) {
        call_user_func($this->onStderr, $payload);
      } else {
        // Stream 0 is stdin echoed back, which an exec without stdin never
        // sends. Treat anything that is not stderr as output.
        if (call_user_func($this->onStdout, $payload) === false) {
          return 0;
        }
      }
    }

    if ($pos > 0) {
      $this->buffer = (string) substr($this->buffer, $pos);
    }

    return strlen($chunk);
  }

  /**
   * True when the stream ended in the middle of a frame.
   *
   * @return bool
   */
  public function hasPartialFrame()
  {
    return $this->buffer !== '';
  }
}
