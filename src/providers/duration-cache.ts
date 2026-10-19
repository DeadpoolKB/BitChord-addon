/**
 * Track durations cached by upstream track ID.
 *
 * We use this when calculating the average FLAC bitrate
 * without downloading the audio file.
 */
const trackDurationCache = new Map<string, number>();

export function getTrackDuration(trackId: string): number | undefined {
  return trackDurationCache.get(trackId);
}

export function setTrackDuration(trackId: string, duration: number): void {
  if (duration > 0) {
    trackDurationCache.set(trackId, duration);
  }
}
