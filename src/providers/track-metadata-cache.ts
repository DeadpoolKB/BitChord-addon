/**
 * Track metadata cached by upstream track ID.
 *
 * We use this to show song names in stream logs.
 */
interface TrackMetadata {
  title: string;
  artist?: string;
  album?: string;
}

const trackMetadataCache = new Map<string, TrackMetadata>();

export function getTrackMetadata(trackId: string): TrackMetadata | undefined {
  return trackMetadataCache.get(trackId);
}

export function setTrackMetadata(trackId: string, metadata: TrackMetadata): void {
  if (metadata.title) {
    trackMetadataCache.set(trackId, metadata);
  }
}
