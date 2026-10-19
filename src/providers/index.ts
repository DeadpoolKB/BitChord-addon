import type { Config } from '../config.js';
import type { QobuzProvider } from '../types.js';
import { StubQobuzProvider } from './stub.js';
import { HttpQobuzProvider } from './http.js';
import { QobuzDlProvider } from './qobuzdl.js';
import { LastBabeProvider } from './lastbabe.js';
import { createRacingProvider } from './racing.js';
import { MonochromeProvider } from './monochrome.js';
import { RemoteAddonProvider } from './remote-addon.js';
import { InstableProvider } from './instable.js';

export type IsolatedSource = 'qobuzdl' | 'lastbabe' | 'monochrome' | 'deezer' | 'eljohnzc' | 'instable';

export function createProvider(config: Config, logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }): QobuzProvider {
  if (config.provider === 'qobuzdl') return new QobuzDlProvider(config, logger);
  if (config.provider === 'multi') {
    return createRacingProvider(
      new QobuzDlProvider(config, logger), new LastBabeProvider(config, logger),
      new MonochromeProvider(config, logger), new RemoteAddonProvider(config, undefined, logger),
      new RemoteAddonProvider(config, config.eljohnzcBaseUrl, logger),
      new InstableProvider(config, logger),
    );
  }
  if (config.provider === 'http') return new HttpQobuzProvider(config);
  return new StubQobuzProvider();
}

export function createSourceProvider(config: Config, source: IsolatedSource, logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }): QobuzProvider {
  if (source === 'qobuzdl') return new QobuzDlProvider({ ...config, apiBaseUrl: config.apiBaseUrl ?? 'https://qobuz-dll.foreyou.workers.dev' }, logger);
  if (source === 'monochrome') return new MonochromeProvider(config, logger);
  if (source === 'deezer') return new RemoteAddonProvider(config, undefined, logger);
  if (source === 'eljohnzc') return new RemoteAddonProvider(config, config.eljohnzcBaseUrl, logger);
  if (source === 'instable') return new InstableProvider(config, logger);
  return new LastBabeProvider(config, logger);
}
