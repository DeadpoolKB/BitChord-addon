const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/135.0.0.0 Mobile Safari/537.36";

/**
 * Determine the average bitrate of a remote audio file
 * without downloading the entire file.
 *
 * First we try HEAD + Content-Length.
 *
 * If the server does not provide Content-Length,
 * we request only byte 0 and read the total size
 * from Content-Range.
 */
export async function getRemoteBitrate(
  streamUrl: string,
  durationSeconds: number
): Promise<number | undefined> {
  if (
    !durationSeconds ||
    durationSeconds <= 0
  ) {
    return undefined;
  }

  try {
    /*
     * First attempt: HEAD request.
     */
    const headResponse = await fetch(
      streamUrl,
      {
        method: "HEAD",
        headers: {
          "User-Agent": BROWSER_USER_AGENT
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    const contentLength =
      headResponse.headers.get(
        "content-length"
      );

    if (contentLength) {
      const fileSize =
        Number(contentLength);

      if (
        Number.isFinite(fileSize) &&
        fileSize > 0
      ) {
        const bitrate = Math.round(
          (fileSize * 8) /
            durationSeconds /
            1000
        );

        return bitrate;
      }
    }

    /*
     * Some CDNs don't return Content-Length
     * for HEAD requests.
     *
     * Request only one byte instead.
     */
    const rangeResponse = await fetch(
      streamUrl,
      {
        method: "GET",
        headers: {
          Range: "bytes=0-0",
          "User-Agent": BROWSER_USER_AGENT
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    const contentRange =
      rangeResponse.headers.get(
        "content-range"
      );

    /*
     * Expected format:
     *
     * bytes 0-0/123456789
     */
    if (contentRange) {
      const match =
        contentRange.match(
          /\/(\d+)$/
        );

      if (match) {
        const fileSize =
          Number(match[1]);

        if (
          Number.isFinite(fileSize) &&
          fileSize > 0
        ) {
          const bitrate = Math.round(
            (fileSize * 8) /
              durationSeconds /
              1000
          );

          return bitrate;
        }
      }
    }

    return undefined;
  } catch (error) {
    console.error(
      "[QOBUZ-DL] Failed to determine bitrate:",
      error
    );

    return undefined;
  }
}
