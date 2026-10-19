import Fastify from 'fastify';
import { loadConfig, type Config } from './config.js';
import { TtlCache } from './cache.js';
import { AppError, badRequest, notFound } from './errors.js';
import { normalizeTrack, streamResponse, upstreamIdFromPublicId } from './normalize.js';
import { createProvider, createSourceProvider, type IsolatedSource } from './providers/index.js';
import type { QobuzProvider, Quality, PublicTrack } from './types.js';

const config = loadConfig();
const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', '*.url'] } });

const manifests = {
  root: { id: 'com.bitchord.qobuz', name: 'k', version: '1.0.0' },
  qobuzdl: { id: 'com.bitchord.qobuz.qobuzdl', name: 'k - Qobuz-DL', version: '1.0.0' },
  lastbabe: { id: 'com.bitchord.qobuz.lastbabe', name: 'k - LastBabe', version: '1.0.0' },
  monochrome: { id: 'com.bitchord.qobuz.monochrome', name: 'k - Monochrome', version: '1.0.0' },
  deezer: { id: 'com.bitchord.qobuz.deezer', name: 'k - Deezer', version: '1.0.0' },
  eljohnzc: { id: 'com.bitchord.qobuz.eljohnzc', name: 'k - Eljohnzc', version: '1.0.0' },
  instable: { id: 'com.bitchord.qobuz.instable', name: 'k - Instable', version: '1.0.0' },
} as const;

registerAddon('', createProvider(config, app.log), manifests.root);
registerAddon('/a', createSourceProvider(config, 'qobuzdl', app.log), manifests.qobuzdl);
registerAddon('/b', createSourceProvider(config, 'lastbabe', app.log), manifests.lastbabe);
registerAddon('/c', createSourceProvider(config, 'monochrome', app.log), manifests.monochrome);
registerAddon('/d', createSourceProvider(config, 'deezer', app.log), manifests.deezer);
registerAddon('/e', createSourceProvider(config, 'eljohnzc', app.log), manifests.eljohnzc);
registerAddon('/f', createSourceProvider(config, 'instable', app.log), manifests.instable);

function registerAddon(prefix: string, provider: QobuzProvider, manifest: { id: string; name: string; version: string }): void {
  const searchCache = new TtlCache<PublicTrack[]>(config.cacheTtlMs);
  const route = (path: string): string => `${prefix}${path}` || '/';

  app.get(route('/manifest.json'), async (_request, reply) => reply.header('Cache-Control', 'public, max-age=3600, s-maxage=86400').send({
    ...manifest, resources: ['search', 'stream'], allowDownloads: 0,
    settings: [{ key: 'quality', type: 'select', default: 'lossless', options: [
      { label: 'Lossless', value: 'lossless' }, { label: 'High', value: 'high' }, { label: 'Low', value: 'low' },
    ] }],
  }));

  app.get<{ Querystring: { q?: string; quality?: string; atmos?: string } }>(route('/search'), async (request, reply) => {
    const query = request.query.q?.trim();
    if (!query) throw badRequest('q is required');
    const quality = parseQuality(request.query.quality);
    const atmos = request.query.atmos ?? 'auto';
    const key = `${query}\u0000${quality}\u0000${atmos}`;
    const cached = searchCache.get(key);
    if (cached) {
      app.log.info(`[SEARCH] Cache hit for "${query}"`);
      return reply.header('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=900').send({ tracks: cached });
    }
    try {
      app.log.info(`[SEARCH] Cache miss for "${query}"`);
      const tracks = (await provider.search(query, quality, atmos)).flatMap(track => {
        try { return [normalizeTrack(track, config.idSecret)]; } catch { return []; }
      });
      searchCache.set(key, tracks);
      app.log.info(`[SEARCH] Success - returned ${tracks.length} tracks for "${query}"`);
      return reply.header('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=900').send({ tracks });
    } catch (error) {
      const stale = searchCache.getStale(key);
      if (stale) {
        app.log.warn(`[SEARCH] Error - serving stale cache for "${query}"`);
        return reply.header('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300').send({ tracks: stale, stale: true });
      }
      app.log.error({ error }, `[SEARCH] Error for "${query}"`);
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { quality?: string; atmos?: string } }>(route('/stream/:id'), async (request, reply) => {
    const quality = parseQuality(request.query.quality);
    const atmos = request.query.atmos ?? 'auto';
    const id = request.params.id;
    if (!/^qobuz_[A-Za-z0-9_-]{10,120}$/.test(id)) throw notFound('track not found');
    const upstreamId = upstreamIdFromPublicId(id, config.idSecret);
    if (!upstreamId) throw notFound('track not available');
    try {
      const stream = await provider.getStream(upstreamId, quality, atmos);
      if (!stream) {
        app.log.warn(`[STREAM] Not found - no stream for track ${id}`);
        throw notFound('track not available');
      }
      if (!stream.url) {
        app.log.warn(`[STREAM] Not found - no URL for track ${id}`);
        throw notFound('track not available');
      }
      app.log.info(`[STREAM] Success - returning stream for track ${id}`);
      return reply.header('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300').send(streamResponse(stream, quality));
    } catch (error) {
      if (error instanceof AppError) throw error;
      app.log.error({ error }, `[STREAM] Error for track ${id}`);
      throw notFound('track has no playable rendition');
    }
  });
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.message });
  const candidate = error as { statusCode?: unknown; status?: unknown };
  const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : typeof candidate.status === 'number' ? candidate.status : 500;
  return reply.code(status).send({ error: status >= 500 ? 'upstream service unavailable' : 'request failed' });
});

function parseQuality(value?: string): Quality {
  const normalized = (value ?? 'LOSSLESS').toUpperCase();
  if (normalized === 'LOSSLESS' || normalized === 'HIGH' || normalized === 'LOW') return normalized;
  throw badRequest('quality must be LOSSLESS, HIGH, or LOW');
}

if (process.env.VERCEL !== '1') {
  app.listen({ host: config.host, port: config.port }).then(() => {
    app.log.info({ host: config.host, port: config.port, provider: config.provider }, 'BitChord addon listening');
  }).catch(error => { app.log.error(error); process.exit(1); });
}

export { app, parseQuality };
