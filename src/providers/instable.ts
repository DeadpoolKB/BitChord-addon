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

export class InstableProvider implements QobuzProvider {
  constructor(private readonly config: Config, private readonly logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }) {}

  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    this.logger?.info(`[INSTABLE] Searching for "${query}"`);
    const body = await this.request('/api/search', { q: query });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const items = data && isRecord(data.tracks) && Array.isArray(data.tracks.items) ? data.tracks.items : [];
    const result = items.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
    this.logger?.info(`[INSTABLE] Search returned ${result.length} tracks for "${query}"`);
    return result;
  }

  async getStream(trackId: string, quality: Quality, _atmos: string): Promise<QobuzStream | null> {
    this.logger?.info(`[INSTABLE] Requesting stream for track ${trackId}`);
    const body = await this.request(`/api/player/stream/${encodeURIComponent(trackId)}`, { quality: qualityId(quality) });
    if (!isRecord(body) || typeof body.url !== 'string' || !/^https:\/\//i.test(body.url)) {
      this.logger?.warn(`[INSTABLE] No valid stream URL for track ${trackId}`);
      return null;
    }

    // Retrieve cached duration for bitrate calculation
    const duration = trackDurationCache.get(trackId);

    // Calculate bitrate if we have duration
    let bitrate: number | undefined;
    if (duration && duration > 0) {
      const bitrateKbps = await getRemoteBitrate(body.url, duration, this.logger);
      if (bitrateKbps !== undefined) {
        bitrate = bitrateKbps * 1000; // Convert to bits per second
      }
    }

    // Extract metadata from upstream response
    const sampleRate = typeof body.sampleRate === 'number' ? body.sampleRate : undefined;
    const bitDepth = typeof body.bitDepth === 'number' ? body.bitDepth : undefined;

    // Fallback to estimated bitrate if remote calculation failed
    if (!bitrate) {
      bitrate = estimateBitrate(sampleRate, bitDepth, quality);
      if (bitrate) {
        this.logger?.info(`[INSTABLE] Using estimated bitrate: ${Math.round(bitrate / 1000)} kbps`);
      }
    }

    this.logger?.info(`[INSTABLE] Stream success for track ${trackId}${bitrate ? ` (bitrate: ${Math.round(bitrate / 1000)} kbps)` : ''}`);

    return {
      url: body.url,
      format: mimeFormat(body.mimeType),
      quality: typeof body.quality === 'number' ? String(body.quality) : quality,
      manifest: 'none',
      encrypted: false,
      sampleRate,
      bitDepth,
      bitrate,
    };
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const base = this.config.instableBaseUrl ?? 'https://instable.arcod.xyz';
    const url = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let lastError: unknown;
    const maxAttempts = Math.max(this.config.upstreamRetries, 2);
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(this.config.requestTimeoutMs, 15000));
      try {
        const response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            referer: `${base.replace(/\/$/, '')}/`,
            origin: base.replace(/\/$/, ''),
          },
          signal: controller.signal,
        });
        let body: unknown;
        try { body = await response.json(); } catch { throw new UpstreamError(502, 'Instable returned invalid JSON'); }
        if (!response.ok) {
          const error = new UpstreamError(retryable(response.status) ? 502 : response.status === 404 ? 404 : 400, 'Instable request failed');
          if (!retryable(response.status) || attempt >= maxAttempts) throw error;
          lastError = error;
        } else if (isRecord(body) && body.success === false) {
          throw new UpstreamError(502, 'Instable request failed');
        } else return body;
      } catch (error) {
        if (error instanceof UpstreamError) {
          if (error.status !== 502 || attempt >= maxAttempts) throw error;
          lastError = error;
        } else lastError = error;
      } finally { clearTimeout(timeout); }
      await delay(200 * 2 ** attempt);
    }
    throw lastError instanceof UpstreamError ? lastError : new UpstreamError(502, 'Instable request failed');
  }
}

function toTrack(raw: RecordValue): QobuzTrack | null {
  const id = raw.id;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const performer = isRecord(raw.performer) ? raw.performer : undefined;
  const album = isRecord(raw.album) ? raw.album : undefined;
  const image = album && isRecord(album.image) ? album.image : undefined;
  const duration = typeof raw.duration === 'number' ? raw.duration : undefined;

  // Cache duration for bitrate calculation
  if (duration && duration > 0) {
    trackDurationCache.set(String(id), duration);
  }

  return {
    upstreamId: String(id),
    title: title.trim(),
    artist: performer && typeof performer.name === 'string' ? performer.name : undefined,
    album: album && typeof album.title === 'string' ? album.title : undefined,
    duration,
    artworkURL: image && typeof image.large === 'string' ? image.large : undefined,
    format: typeof raw.maximum_bit_depth === 'number' ? 'flac' : undefined,
    audioQuality: typeof raw.maximum_bit_depth === 'number' ? 'LOSSLESS' : undefined,
  };
}

function qualityId(quality: Quality): string { return quality === 'LOSSLESS' ? '27' : '5'; }
function mimeFormat(value: unknown): string | undefined { return typeof value === 'string' ? value.split('/').pop() : undefined; }
function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null; }
function retryable(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
