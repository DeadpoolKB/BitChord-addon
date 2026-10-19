import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';
import { getRemoteBitrate, estimateBitrate } from '../bitrate.js';

type JsonRecord = Record<string, unknown>;

/**
 * Track durations cached by Qobuz track ID.
 *
 * We use this when calculating the average FLAC bitrate
 * without downloading the audio file.
 */
const trackDurationCache = new Map<string, number>();

/** Adapter for the public Qobuz-DL-compatible JSON API. */
export class QobuzDlProvider implements QobuzProvider {
  constructor(private readonly config: Config, private readonly logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }) {}

  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    this.logger?.info(`[QOBUZ-DL] Searching for "${query}"`);
    const body = await this.request('/api/get-music', { q: query, offset: '0' });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const tracks = data && isRecord(data.tracks) && Array.isArray(data.tracks.items) ? data.tracks.items : [];
    const result = tracks.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
    this.logger?.info(`[QOBUZ-DL] Search returned ${result.length} tracks for "${query}"`);
    return result;
  }

  async getStream(trackId: string, quality: Quality, _atmos: string): Promise<QobuzStream | null> {
    this.logger?.info(`[QOBUZ-DL] Requesting stream for track ${trackId}`);
    const body = await this.request('/api/download-music', { track_id: trackId, quality: qualityId(quality) });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const url = data && typeof data.url === 'string' ? data.url : undefined;
    if (!url || !/^https:\/\//i.test(url)) {
      this.logger?.warn(`[QOBUZ-DL] No valid stream URL for track ${trackId}`);
      return null;
    }

    // Retrieve cached duration for bitrate calculation
    const duration = trackDurationCache.get(trackId);

    // Calculate bitrate if we have duration
    let bitrate: number | undefined;
    if (duration && duration > 0) {
      const bitrateKbps = await getRemoteBitrate(url, duration, this.logger);
      if (bitrateKbps !== undefined) {
        bitrate = bitrateKbps * 1000; // Convert to bits per second
      }
    }

    // Extract audio metadata from upstream response if available
    const bitDepth = data && typeof data.bit_depth === 'number' ? data.bit_depth : undefined;
    const samplingRate = data && typeof data.sampling_rate === 'number' ? data.sampling_rate : undefined;
    const sampleRate = samplingRate ? Math.round(samplingRate * 1000) : undefined;

    // Fallback to estimated bitrate if remote calculation failed
    if (!bitrate) {
      bitrate = estimateBitrate(sampleRate, bitDepth, quality);
      if (bitrate) {
        this.logger?.info(`[QOBUZ-DL] Using estimated bitrate: ${Math.round(bitrate / 1000)} kbps`);
      }
    }

    this.logger?.info(`[QOBUZ-DL] Stream success for track ${trackId}${bitrate ? ` (bitrate: ${Math.round(bitrate / 1000)} kbps)` : ''}`);

    return {
      url,
      format: 'flac',
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate,
      bitDepth,
      bitrate,
    };
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.config.apiBaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.upstreamRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
        let body: unknown;
        try { body = await response.json(); } catch { throw new UpstreamError(502, 'Qobuz-DL provider returned invalid JSON'); }
        if (!response.ok) {
          const error = new UpstreamError(retryableStatus(response.status) ? 502 : response.status === 404 ? 404 : 400, upstreamMessage(body));
          if (!retryableStatus(response.status) || attempt >= this.config.upstreamRetries) throw error;
          lastError = error;
        } else if (isRecord(body) && body.success === false) {
          const error = new UpstreamError(502, upstreamMessage(body));
          if (attempt >= this.config.upstreamRetries) throw error;
          lastError = error;
        } else return body;
      } catch (error) {
        if (error instanceof UpstreamError) {
          if (error.status !== 502 || attempt >= this.config.upstreamRetries) throw error;
        }
        lastError = error;
      } finally { clearTimeout(timeout); }
      await delay(200 * 2 ** attempt);
    }
    throw lastError instanceof UpstreamError ? lastError : new UpstreamError(502, 'Qobuz-DL provider request failed');
  }
}

function retryableStatus(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function qualityId(quality: Quality): string {
  // IDs verified from the Qobuz-DL route schema: 27, 7, 6, and 5.
  // Lossless uses the app default; HIGH/LOW use its MP3 rendition because
  // this public endpoint exposes no separate low-bitrate contract.
  if (quality === 'LOSSLESS') return '27';
  return '5';
}

function toTrack(raw: JsonRecord): QobuzTrack | null {
  const id = raw.id;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const album = isRecord(raw.album) ? raw.album : undefined;
  const performer = isRecord(raw.performer) ? raw.performer : undefined;
  const image = album && isRecord(album.image) ? album.image : undefined;
  const artworkURL = image && typeof image.large === 'string' ? image.large : undefined;
  const maxBitDepth = typeof raw.maximum_bit_depth === 'number' ? raw.maximum_bit_depth : undefined;
  const duration = typeof raw.duration === 'number' ? raw.duration : undefined;

  // Cache duration for bitrate calculation
  if (duration && duration > 0) {
    trackDurationCache.set(String(id), duration);
  }

  return {
    upstreamId: String(id), title: title.trim(),
    artist: performer && typeof performer.name === 'string' ? performer.name : undefined,
    album: album && typeof album.title === 'string' ? album.title : undefined,
    duration,
    artworkURL, format: maxBitDepth ? 'flac' : undefined,
    audioQuality: maxBitDepth ? 'LOSSLESS' : undefined,
  };
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null; }
function upstreamMessage(body: unknown): string {
  if (isRecord(body) && typeof body.error === 'string') return `Qobuz-DL upstream error: ${body.error}`;
  return 'Qobuz-DL upstream request failed';
}
