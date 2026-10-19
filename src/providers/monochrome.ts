import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';
import { getRemoteBitrate, estimateBitrate } from '../bitrate.js';

type RecordValue = Record<string, unknown>;

/**
 * Track durations cached by track ID.
 *
 * We use this when calculating the average FLAC bitrate
 * without downloading the audio file.
 */
const trackDurationCache = new Map<string, number>();

export class MonochromeProvider implements QobuzProvider {
  constructor(private readonly config: Config, private readonly logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }) {}

  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    this.logger?.info(`[MONOCHROME] Searching for "${query}"`);
    const body = await this.request('/search/tracks', { q: query, limit: '10' });
    const items = isRecord(body) && Array.isArray(body.tracks) ? body.tracks : [];
    const result = items.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
    this.logger?.info(`[MONOCHROME] Search returned ${result.length} tracks for "${query}"`);
    return result;
  }

  async getStream(trackId: string, _quality: Quality, _atmos: string): Promise<QobuzStream | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(trackId)) return null;
    this.logger?.info(`[MONOCHROME] Requesting stream for track ${trackId}`);

    const streamUrl = new URL(`/track/${encodeURIComponent(trackId)}`, this.baseUrl()).toString();

    // Retrieve cached duration for bitrate calculation
    const duration = trackDurationCache.get(trackId);

    // Calculate bitrate if we have duration
    let bitrate: number | undefined;
    if (duration && duration > 0) {
      const bitrateKbps = await getRemoteBitrate(streamUrl, duration, this.logger);
      if (bitrateKbps !== undefined) {
        bitrate = bitrateKbps * 1000; // Convert to bits per second
      }
    }

    // Fallback to estimated bitrate if remote calculation failed
    if (!bitrate) {
      bitrate = estimateBitrate(undefined, undefined, _quality);
      if (bitrate) {
        this.logger?.info(`[MONOCHROME] Using estimated bitrate: ${Math.round(bitrate / 1000)} kbps`);
      }
    }

    this.logger?.info(`[MONOCHROME] Stream success for track ${trackId}${bitrate ? ` (bitrate: ${Math.round(bitrate / 1000)} kbps)` : ''}`);

    return {
      url: streamUrl,
      format: 'flac',
      quality: 'LOSSLESS',
      manifest: 'none',
      encrypted: false,
      bitrate,
    };
  }

  private baseUrl(): string { return this.config.monochromeBaseUrl ?? 'https://tracks.monochrome.st'; }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl());
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(this.config.requestTimeoutMs, 10000));
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
        let body: unknown;
        try { body = await response.json(); } catch { throw new UpstreamError(502, 'Monochrome returned invalid JSON'); }
        if (!response.ok) throw new UpstreamError(response.status >= 500 ? 502 : response.status, 'Monochrome request failed');
        return body;
      } catch (error) {
        lastError = error;
        if (error instanceof UpstreamError && error.status < 500) throw error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200));
      } finally { clearTimeout(timeout); }
    }
    if (lastError instanceof UpstreamError) throw lastError;
    throw new UpstreamError(502, 'Monochrome request failed');
  }
}

function toTrack(raw: RecordValue): QobuzTrack | null {
  const id = raw.id ?? raw.trackId;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const artists = Array.isArray(raw.artistNames) ? raw.artistNames.filter((v): v is string => typeof v === 'string') : [];
  const duration = typeof raw.duration === 'number' ? Math.round(raw.duration / 1000) : undefined;

  // Cache duration for bitrate calculation
  if (duration && duration > 0) {
    trackDurationCache.set(String(id), duration);
  }

  return {
    upstreamId: String(id), title: title.trim(), artist: artists.join(', ') || undefined,
    artworkURL: typeof raw.artwork === 'string' ? raw.artwork : undefined,
    duration, format: 'flac', audioQuality: 'LOSSLESS',
  };
}

function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null; }
