export type Quality = "lossless" | "high" | "low";

export interface Track {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  artworkURL?: string;
  format?: string;
  audioQuality?: string;
  isrc?: string;
}

export interface Stream {
  url: string;
  format?: string;
  quality?: string;
  codec?: string;
  container?: string;
  manifest?: "none" | "hls" | "dash";
  encrypted?: boolean;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
}

export interface MusicProvider {
  search(
    query: string,
    quality: Quality,
    atmos: string
  ): Promise<Track[]>;

  findByIsrc(
    isrc: string,
    quality: Quality
  ): Promise<Track | null>;

  getStream(
    id: string,
    quality: Quality,
    atmos: string
  ): Promise<Stream | null>;

  getTrackMetadata(
    id: string
  ): {title: string, artist?: string, album?: string} | undefined;
}
