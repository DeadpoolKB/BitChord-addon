const BROWSER_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/135.0.0.0 Mobile Safari/537.36';

/**
 * Determine the average bitrate of a remote audio file
 * without downloading the entire file.
 *
 * First we try HEAD + Content-Length.
 *
 * If the server does not provide Content-Length,
 * we request only byte 0 and read the total size
 * from Content-Range.
 *
 * @param streamUrl - The URL of the audio file
 * @param durationSeconds - Duration of the track in seconds
 * @param logger - Optional logger for debugging
 * @returns Bitrate in kbps, or undefined if calculation fails
 */
export async function getRemoteBitrate(
  streamUrl: string,
  durationSeconds: number,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<number | undefined> {
  if (!durationSeconds || durationSeconds <= 0) {
    logger?.warn('[BITRATE] Invalid duration for bitrate calculation');
    return undefined;
  }

  try {
    /*
     * First attempt: HEAD request.
     */
    const headResponse = await fetch(streamUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
      },
      signal: AbortSignal.timeout(2000), // 2s timeout for speed
    });

    const contentLength = headResponse.headers.get('content-length');

    if (contentLength) {
      const fileSize = Number(contentLength);

      if (Number.isFinite(fileSize) && fileSize > 0) {
        const bitrate = Math.round((fileSize * 8) / durationSeconds / 1000);
        logger?.info(`[BITRATE] Calculated from HEAD: ${bitrate} kbps`);
        return bitrate;
      }
    }

    /*
     * Some CDNs don't return Content-Length
     * for HEAD requests.
     *
     * Request only one byte instead.
     */
    const rangeResponse = await fetch(streamUrl, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': BROWSER_USER_AGENT,
      },
      signal: AbortSignal.timeout(2000), // 2s timeout for speed
    });

    const contentRange = rangeResponse.headers.get('content-range');

    /*
     * Expected format:
     *
     * bytes 0-0/123456789
     */
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/);

      if (match) {
        const fileSize = Number(match[1]);

        if (Number.isFinite(fileSize) && fileSize > 0) {
          const bitrate = Math.round((fileSize * 8) / durationSeconds / 1000);
          logger?.info(`[BITRATE] Calculated from Range: ${bitrate} kbps`);
          return bitrate;
        }
      }
    }

    logger?.warn('[BITRATE] No Content-Length or Content-Range available');
    return undefined;
  } catch (error) {
    logger?.warn(`[BITRATE] Failed to calculate bitrate: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Estimate bitrate from audio quality metadata.
 * This is a fallback when remote bitrate calculation fails.
 *
 * @param sampleRate - Sample rate in Hz
 * @param bitDepth - Bit depth
 * @param quality - Quality tier (LOSSLESS, HIGH, LOW)
 * @returns Estimated bitrate in bits per second
 */
export function estimateBitrate(
  sampleRate?: number,
  bitDepth?: number,
  quality?: string
): number | undefined {
  // If we have both sample rate and bit depth, calculate uncompressed bitrate
  if (sampleRate && bitDepth) {
    // FLAC compression ratio is typically 0.5-0.7 of uncompressed
    const uncompressedBitrate = sampleRate * bitDepth * 2; // 2 channels for stereo
    const estimated = Math.round(uncompressedBitrate * 0.6); // 60% of uncompressed (typical FLAC compression)
    return estimated;
  }

  // Fallback to quality-based estimates
  if (quality === 'LOSSLESS') {
    return 1411200; // ~1.4 Mbps (typical FLAC average)
  }
  if (quality === 'HIGH') {
    return 320000; // 320 kbps
  }
  if (quality === 'LOW') {
    return 128000; // 128 kbps
  }

  return undefined;
}
