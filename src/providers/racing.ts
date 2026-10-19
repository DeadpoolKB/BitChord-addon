import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';

interface Source { name: string; provider: QobuzProvider }

const QUALITY_WINDOW_MS = 250;

export class RacingProvider implements QobuzProvider {
  constructor(private readonly sources: Source[]) {}

  async search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]> {
    return new Promise((resolve, reject) => {
      let pending = this.sources.length;
      let lastError: unknown;
      const results: Array<{ source: string; tracks: QobuzTrack[] }> = [];
      let resolved = false;

      const maybeResolve = () => {
        if (resolved) return;
        if (results.length === 0) return;

        // Prioritize 24-bit results
        const bitDepth24Results = results.filter(r =>
          r.tracks.some(t => t.audioQuality === 'LOSSLESS' && t.format === 'flac')
        );

        if (bitDepth24Results.length > 0) {
          // Return first 24-bit result
          const best = bitDepth24Results[0];
          resolved = true;
          resolve(best.tracks.map(track => ({ ...track, upstreamId: `${best.source}:${track.upstreamId}` })));
          return;
        }

        // No 24-bit, return first result
        const first = results[0];
        resolved = true;
        resolve(first.tracks.map(track => ({ ...track, upstreamId: `${first.source}:${track.upstreamId}` })));
      };

      for (const source of this.sources) {
        source.provider.search(query, quality, atmos).then(tracks => {
          if (resolved) return;

          if (tracks.length > 0) {
            results.push({ source: source.name, tracks });
            maybeResolve();
          }

          pending -= 1;
          if (pending === 0 && !resolved) {
            maybeResolve();
            if (!resolved) resolve([]);
          }
        }).catch(error => {
          if (resolved) return;
          lastError = error;
          pending -= 1;
          if (pending === 0 && !resolved) {
            maybeResolve();
            if (!resolved) reject(lastError);
          }
        });
      }

      // Quality window: if we have results after timeout, resolve with best quality
      setTimeout(() => {
        if (!resolved) {
          maybeResolve();
          if (!resolved && pending === 0) {
            if (results.length > 0) {
              maybeResolve();
            } else {
              reject(lastError || new Error('No results found'));
            }
          }
        }
      }, QUALITY_WINDOW_MS);
    });
  }

  async getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null> {
    const separator = trackId.indexOf(':');
    if (separator <= 0) return null;
    const sourceName = trackId.slice(0, separator);
    const upstreamId = trackId.slice(separator + 1);
    const source = this.sources.find(candidate => candidate.name === sourceName);
    return source ? source.provider.getStream(upstreamId, quality, atmos) : null;
  }
}

export function createRacingProvider(
  qobuzdl: QobuzProvider,
  lastbabe: QobuzProvider,
  optional?: QobuzProvider,
  monochrome?: QobuzProvider,
  deezer?: QobuzProvider,
): QobuzProvider {
  const sources: Source[] = [
    { name: 'lastbabe', provider: lastbabe },
    { name: 'qobuzdl', provider: qobuzdl },
  ];
  if (deezer) sources.unshift({ name: 'deezer', provider: deezer });
  if (monochrome) sources.unshift({ name: 'monochrome', provider: monochrome });
  if (optional) sources.unshift({ name: 'optional', provider: optional });
  return new RacingProvider(sources);
}
