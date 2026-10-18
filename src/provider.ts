import type {
  MusicProvider,
  Quality,
  Stream,
  Track
} from "./types";

const QOBUZ_DL_BASE_URL = "https://qobuz-dll.vercel.app";
const ARCOD_BASE_URL = "https://arcod.xyz";
const LASTBABE_BASE_URL = "https://lastbabe-addon.de.deplexo.com";
const MONOCHROME_BASE_URL = "https://tracks.monochrome.st";
const DEEZER_BASE_URL = "https://dzr.tabs-vs-spaces.wtf";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/135.0.0.0 Mobile Safari/537.36";

const CACHE_TTL = 5 * 60 * 1000;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10000;

const cache = new Map<
  string,
  {
    expires: number;
    value: Track[];
  }
>();

/**
 * Track durations cached by Qobuz track ID.
 *
 * We use this when calculating the average FLAC bitrate
 * without downloading the audio file.
 */
const trackDurationCache = new Map<
  string,
  number
>();

/**
 * Track metadata cached by Qobuz track ID.
 *
 * We use this to show song names in stream logs.
 */
const trackMetadataCache = new Map<
  string,
  {
    title: string;
    artist?: string;
    album?: string;
  }
>();

function cacheKey(
  query: string,
  quality: Quality
): string {
  return `${quality}:${query.toLowerCase()}`;
}

function getCached(
  key: string
): Track[] | null {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCached(
  key: string,
  value: Track[]
): void {
  cache.set(key, {
    expires: Date.now() + CACHE_TTL,
    value
  });
}

function qualityToFormatId(
  quality: Quality
): number {
  switch (quality) {
    case "lossless":
      return 27; // Hi-Res Lossless

    case "high":
      return 5; // AAC 320

    case "low":
      return 5; // AAC 320 fallback
  }
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(value: string): Set<string> {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "feat",
    "ft",
    "for",
    "of",
    "the",
    "with"
  ]);

  return new Set(
    normalize(value)
      .split(" ")
      .filter(token => token.length > 1 && !stopWords.has(token))
  );
}

function wordsOverlap(a: string, b: string): number {
  const left = significantTokens(a);
  const right = significantTokens(b);

  let count = 0;

  for (const word of left) {
    if (right.has(word)) {
      count++;
    }
  }

  return count;
}

function artistsMatch(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);

  return (
    left === right ||
    left.includes(right) ||
    right.includes(left)
  );
}

function versionPenalty(query: string, candidate: string): number {
  const strictTokens = [
    "remix",
    "live",
    "instrumental",
    "karaoke",
    "sped up",
    "slowed"
  ];

  const softTokens = [
    "remaster",
    "remastered",
    "edit",
    "acoustic",
    "version",
    "mono",
    "stereo",
    "deluxe"
  ];

  const queryNormalized = normalize(query);
  const candidateNormalized = normalize(candidate);

  const queryHasStrict = strictTokens.some(token =>
    queryNormalized.includes(token)
  );

  const candidateHasStrict = strictTokens.some(token =>
    candidateNormalized.includes(token)
  );

  if (candidateHasStrict && !queryHasStrict) {
    return -1000;
  }

  const queryHasSoft = softTokens.some(token =>
    queryNormalized.includes(token)
  );

  const candidateHasSoft = softTokens.some(token =>
    candidateNormalized.includes(token)
  );

  if (candidateHasSoft && !queryHasSoft) {
    return -45;
  }

  return 0;
}

interface ScoredTrack {
  track: Track;
  score: number;
}

function scoreTrack(
  query: string,
  candidate: Track
): number {
  const queryNormalized = normalize(query);
  const candidateTitle = normalize(candidate.title);
  const candidateAlbum = normalize(candidate.album || "");
  const candidateArtist = normalize(candidate.artist || "");

  let score = 0;

  // Version handling
  score += versionPenalty(queryNormalized, candidateTitle);

  // Title matching
  if (candidateTitle === queryNormalized) {
    score += 360;
  } else if (
    candidateTitle.includes(queryNormalized) ||
    queryNormalized.includes(candidateTitle)
  ) {
    score += 180;
  } else if (wordsOverlap(queryNormalized, candidateTitle) >= 3) {
    score += 110;
  } else if (wordsOverlap(queryNormalized, candidateTitle) >= 1) {
    score += 50;
  } else {
    score -= 120;
  }

  // Artist matching
  if (candidateArtist && queryNormalized.includes(candidateArtist)) {
    score += 80;
  } else if (candidateArtist && artistsMatch(queryNormalized, candidateArtist)) {
    score += 60;
  }

  // Album matching
  if (candidateAlbum && queryNormalized.includes(candidateAlbum)) {
    score += 40;
  }

  // Bonus for Hi-Res
  if (candidate.audioQuality === "LOSSLESS") {
    score += 15;
  }

  return score;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Search Qobuz-DL for tracks with retry logic.
 */
async function searchTracksQobuzDL(
  term: string
): Promise<Track[]> {
  const url = new URL(
    `${QOBUZ_DL_BASE_URL}/api/get-music`
  );

  url.searchParams.set("q", term);
  url.searchParams.set("offset", "0");

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[QOBUZ-DL] Search HTTP ${response.status} ${response.statusText}`
          );
          return [];
        }

        console.log(
          `[QOBUZ-DL] Search HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[QOBUZ-DL] Empty search response"
        );
        return [];
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[QOBUZ-DL] Search returned HTML:",
          payload.substring(0, 500)
        );
        return [];
      }

      const data = JSON.parse(payload);

      if (!data.success) {
        if (attempt >= MAX_RETRIES) {
          console.error(
            `[QOBUZ-DL] Search rejected: ${data.error ?? "unknown error"}`
          );
          return [];
        }

        console.log(
          `[QOBUZ-DL] Search rejected, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(data.error || "Search rejected");
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const tracks = data.data?.tracks?.items;

      if (!Array.isArray(tracks)) {
        return [];
      }

      const converted: Track[] = [];

      for (const item of tracks) {
        const track = convertResult(item);

        if (track) {
          converted.push(track);

          /*
           * Save the duration so getStream() can later
           * calculate the FLAC bitrate.
           */
          if (
            track.id &&
            typeof track.duration === "number" &&
            track.duration > 0
          ) {
            trackDurationCache.set(
              track.id,
              track.duration
            );
          }
        }
      }

      return converted;
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[QOBUZ-DL] Search request failed:",
          error
        );
        return [];
      }

      console.log(
        `[QOBUZ-DL] Search request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[QOBUZ-DL] Search failed after retries:",
    lastError
  );

  return [];
}

function convertResult(
  value: unknown
): Track | null {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return null;
  }

  const obj =
    value as Record<string, unknown>;

  const title =
    typeof obj.title === "string"
      ? obj.title
      : "";

  if (!title) {
    return null;
  }

  let artist: string | undefined;

  /*
   * Qobuz-DL normally returns the artist as:
   *
   * performer: {
   *   name: "Linkin Park"
   * }
   *
   * We also support artist/name formats.
   */
  if (typeof obj.artist === "string") {
    artist = obj.artist;
  } else if (
    typeof obj.artist === "object" &&
    obj.artist !== null &&
    typeof (
      obj.artist as Record<string, unknown>
    ).name === "string"
  ) {
    artist = String(
      (
        obj.artist as Record<string, unknown>
      ).name
    );
  } else if (
    typeof obj.performer === "object" &&
    obj.performer !== null &&
    typeof (
      obj.performer as Record<string, unknown>
    ).name === "string"
  ) {
    artist = String(
      (
        obj.performer as Record<string, unknown>
      ).name
    );
  }

  const artists: string[] = [];

  if (artist) {
    artists.push(artist);
  }

  if (Array.isArray(obj.artists)) {
    for (const value of obj.artists) {
      if (typeof value === "string") {
        artists.push(value);
      } else if (
        typeof value === "object" &&
        value !== null &&
        typeof (
          value as Record<string, unknown>
        ).name === "string"
      ) {
        artists.push(
          String(
            (
              value as Record<string, unknown>
            ).name
          )
        );
      }
    }
  }

  const uniqueArtists =
    [...new Set(artists)];

  let album: string | undefined;

  if (typeof obj.album === "string") {
    album = obj.album;
  } else if (
    typeof obj.album === "object" &&
    obj.album !== null &&
    typeof (
      obj.album as Record<string, unknown>
    ).title === "string"
  ) {
    album = String(
      (
        obj.album as Record<string, unknown>
      ).title
    );
  }

  const duration =
    typeof obj.duration === "number"
      ? obj.duration
      : undefined;

  const hires = obj.hires === true;

  const format = hires
    ? "flac"
    : "flac";

  const audioQuality = hires
    ? "LOSSLESS"
    : "LOSSLESS";

  const trackId =
    typeof obj.id === "string"
      ? obj.id
      : String(obj.id ?? "");

  // Store metadata in cache for stream logs
  if (trackId) {
    trackMetadataCache.set(trackId, {
      title,
      artist: uniqueArtists[0],
      album
    });
  }

  return {
    id: trackId,

    title,

    artist: uniqueArtists[0],

    album,

    duration,

    artworkURL:
      typeof obj.image === "object" &&
      obj.image !== null &&
      typeof (
        obj.image as Record<string, unknown>
      ).large === "string"
        ? String(
            (
              obj.image as Record<string, unknown>
            ).large
          )
        : typeof obj.artwork === "string"
          ? obj.artwork
          : undefined,

    format,

    audioQuality,

    isrc:
      typeof obj.isrc === "string"
        ? obj.isrc
        : undefined
  };
}

/**
 * Convert LastBabe result to Track format.
 */
function convertLastBabeResult(
  value: unknown
): Track | null {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return null;
  }

  const obj =
    value as Record<string, unknown>;

  const title =
    typeof obj.title === "string"
      ? obj.title
      : "";

  if (!title) {
    return null;
  }

  const trackId =
    obj.trackId ?? obj.id;

  const id =
    typeof trackId === "string"
      ? trackId
      : typeof trackId === "number"
        ? String(trackId)
        : "";

  if (!id) {
    return null;
  }

  let artist: string | undefined;

  if (typeof obj.artist === "string") {
    artist = obj.artist;
  } else if (
    Array.isArray(obj.artists) &&
    obj.artists.length > 0
  ) {
    const artists = obj.artists
      .filter((a): a is string => typeof a === "string");

    if (artists.length > 0) {
      artist = artists.join(", ");
    }
  }

  const album =
    typeof obj.album === "string"
      ? obj.album
      : undefined;

  const duration =
    typeof obj.duration === "number"
      ? obj.duration
      : undefined;

  const artworkURL =
    typeof obj.artwork === "string"
      ? obj.artwork
      : typeof obj.artworkURL === "string"
        ? obj.artworkURL
        : undefined;

  const format =
    typeof obj.format === "string"
      ? obj.format
      : undefined;

  const audioQuality =
    typeof obj.audioQuality === "string"
      ? obj.audioQuality
      : undefined;

  // Store metadata in cache for stream logs
  trackMetadataCache.set(id, {
    title,
    artist,
    album
  });

  // Save duration for bitrate calculation
  if (
    duration &&
    duration > 0
  ) {
    trackDurationCache.set(id, duration);
  }

  return {
    id,
    title,
    artist,
    album,
    duration,
    artworkURL,
    format,
    audioQuality,
    isrc:
      typeof obj.isrc === "string"
        ? obj.isrc
        : undefined
  };
}

/**
 * Search LastBabe for tracks with retry logic.
 */
async function searchTracksLastBabe(
  term: string
): Promise<Track[]> {
  const url = new URL(
    `${LASTBABE_BASE_URL}/search`
  );

  url.searchParams.set("q", term);

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[LASTBABE] Search HTTP ${response.status} ${response.statusText}`
          );
          return [];
        }

        console.log(
          `[LASTBABE] Search HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[LASTBABE] Empty search response"
        );
        return [];
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[LASTBABE] Search returned HTML:",
          payload.substring(0, 500)
        );
        return [];
      }

      const data = JSON.parse(payload);

      const tracks = data.tracks;

      if (!Array.isArray(tracks)) {
        return [];
      }

      const converted: Track[] = [];

      for (const item of tracks) {
        const track = convertLastBabeResult(item);

        if (track) {
          converted.push(track);
        }
      }

      return converted;
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[LASTBABE] Search request failed:",
          error
        );
        return [];
      }

      console.log(
        `[LASTBABE] Search request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[LASTBABE] Search failed after retries:",
    lastError
  );

  return [];
}

/**
 * Request stream from LastBabe with retry logic.
 */
async function requestLastBabeStream(
  trackId: string,
  quality: Quality,
  durationSeconds?: number
): Promise<Stream | null> {
  const url = new URL(
    `${LASTBABE_BASE_URL}/stream/${encodeURIComponent(trackId)}`
  );

  url.searchParams.set("quality", quality);

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[LASTBABE] Stream HTTP ${response.status} ${response.statusText}`
          );
          return null;
        }

        console.log(
          `[LASTBABE] Stream HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[LASTBABE] Empty stream response"
        );
        return null;
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[LASTBABE] Stream returned HTML:",
          payload.substring(0, 500)
        );
        return null;
      }

      const data = JSON.parse(payload);

      const streamUrl = data.url;

      if (
        typeof streamUrl !== "string" ||
        !/^https:\/\//i.test(streamUrl)
      ) {
        console.error(
          "[LASTBABE] Invalid or missing stream URL"
        );
        return null;
      }

      const bitrateKbps =
        durationSeconds
          ? await getRemoteBitrate(
              streamUrl,
              durationSeconds
            )
          : undefined;

      const bitrate =
        bitrateKbps !== undefined
          ? bitrateKbps * 1000
          : undefined;

      return {
        url: streamUrl,
        format:
          typeof data.format === "string"
            ? data.format
            : undefined,
        quality:
          typeof data.quality === "string"
            ? data.quality
            : quality,
        codec:
          typeof data.codec === "string"
            ? data.codec
            : undefined,
        container:
          typeof data.container === "string"
            ? data.container
            : undefined,
        manifest:
          data.manifest === "hls" ||
          data.manifest === "dash"
            ? data.manifest
            : "none",
        encrypted: data.encrypted === true,
        sampleRate:
          typeof data.sampleRate === "number"
            ? data.sampleRate
            : undefined,
        bitDepth:
          typeof data.bitDepth === "number"
            ? data.bitDepth
            : undefined,
        bitrate
      };
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[LASTBABE] Stream request failed:",
          error
        );
        return null;
      }

      console.log(
        `[LASTBABE] Stream request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[LASTBABE] Stream failed after retries:",
    lastError
  );

  return null;
}

/**
 * Convert Monochrome result to Track format.
 */
function convertMonochromeResult(
  value: unknown
): Track | null {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return null;
  }

  const obj =
    value as Record<string, unknown>;

  const id = obj.id ?? obj.trackId;
  const title = obj.title;

  if (
    (typeof id !== "number" && typeof id !== "string") ||
    typeof title !== "string" ||
    !title.trim()
  ) {
    return null;
  }

  const trackId = String(id);

  const artists: string[] = [];

  if (Array.isArray(obj.artistNames)) {
    for (const v of obj.artistNames) {
      if (typeof v === "string") {
        artists.push(v);
      }
    }
  }

  const duration =
    typeof obj.duration === "number"
      ? Math.round(obj.duration / 1000)
      : undefined;

  const artworkURL =
    typeof obj.artwork === "string"
      ? obj.artwork
      : undefined;

  // Store metadata in cache for stream logs
  trackMetadataCache.set(trackId, {
    title: title.trim(),
    artist: artists[0],
    album: undefined
  });

  // Save duration for bitrate calculation
  if (
    duration &&
    duration > 0
  ) {
    trackDurationCache.set(trackId, duration);
  }

  return {
    id: trackId,
    title: title.trim(),
    artist: artists.length > 0 ? artists.join(", ") : undefined,
    album: undefined,
    duration,
    artworkURL,
    format: "flac",
    audioQuality: "LOSSLESS"
  };
}

/**
 * Search Monochrome for tracks with retry logic.
 */
async function searchTracksMonochrome(
  term: string
): Promise<Track[]> {
  const url = new URL(
    `${MONOCHROME_BASE_URL}/search/tracks`
  );

  url.searchParams.set("q", term);
  url.searchParams.set("limit", "10");

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[MONOCHROME] Search HTTP ${response.status} ${response.statusText}`
          );
          return [];
        }

        console.log(
          `[MONOCHROME] Search HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[MONOCHROME] Empty search response"
        );
        return [];
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[MONOCHROME] Search returned HTML:",
          payload.substring(0, 500)
        );
        return [];
      }

      const data = JSON.parse(payload);

      const tracks = data.tracks;

      if (!Array.isArray(tracks)) {
        return [];
      }

      const converted: Track[] = [];

      for (const item of tracks) {
        const track = convertMonochromeResult(item);

        if (track) {
          converted.push(track);
        }
      }

      return converted;
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[MONOCHROME] Search request failed:",
          error
        );
        return [];
      }

      console.log(
        `[MONOCHROME] Search request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[MONOCHROME] Search failed after retries:",
    lastError
  );

  return [];
}

/**
 * Request stream from Monochrome.
 */
async function requestMonochromeStream(
  trackId: string,
  _quality: Quality,
  _atmos: string,
  durationSeconds?: number
): Promise<Stream | null> {
  // Validate track ID format
  if (!/^[A-Za-z0-9_-]+$/.test(trackId)) {
    console.error(
      "[MONOCHROME] Invalid track ID format"
    );
    return null;
  }

  const streamUrl = `${MONOCHROME_BASE_URL}/track/${encodeURIComponent(trackId)}`;

  const bitrateKbps =
    durationSeconds
      ? await getRemoteBitrate(
          streamUrl,
          durationSeconds
        )
      : undefined;

  const bitrate =
    bitrateKbps !== undefined
      ? bitrateKbps * 1000
      : undefined;

  return {
    url: streamUrl,
    format: "flac",
    quality: "LOSSLESS",
    codec: "flac",
    container: "flac",
    manifest: "none",
    encrypted: false,
    bitrate
  };
}

/**
 * Convert Deezer result to Track format.
 */
function convertDeezerResult(
  value: unknown
): Track | null {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return null;
  }

  const obj =
    value as Record<string, unknown>;

  const id = obj.id;
  const title = obj.title;

  if (
    (typeof id !== "number" && typeof id !== "string") ||
    typeof title !== "string" ||
    !title.trim()
  ) {
    return null;
  }

  const trackId = String(id);

  let artist: string | undefined;

  if (typeof obj.artist === "string") {
    artist = obj.artist;
  } else if (
    typeof obj.artist === "object" &&
    obj.artist !== null &&
    typeof (
      obj.artist as Record<string, unknown>
    ).name === "string"
  ) {
    artist = String(
      (
        obj.artist as Record<string, unknown>
      ).name
    );
  }

  let album: string | undefined;

  if (typeof obj.album === "string") {
    album = obj.album;
  } else if (
    typeof obj.album === "object" &&
    obj.album !== null &&
    typeof (
      obj.album as Record<string, unknown>
    ).title === "string"
  ) {
    album = String(
      (
        obj.album as Record<string, unknown>
      ).title
    );
  }

  const duration =
    typeof obj.duration === "number"
      ? obj.duration
      : undefined;

  const artworkURL =
    typeof obj.artworkURL === "string"
      ? obj.artworkURL
      : typeof obj.artwork === "string"
        ? obj.artwork
        : undefined;

  // Store metadata in cache for stream logs
  trackMetadataCache.set(trackId, {
    title: title.trim(),
    artist,
    album
  });

  // Save duration for bitrate calculation
  if (
    duration &&
    duration > 0
  ) {
    trackDurationCache.set(trackId, duration);
  }

  return {
    id: trackId,
    title: title.trim(),
    artist,
    album,
    duration,
    artworkURL,
    format: undefined,
    audioQuality: undefined
  };
}

/**
 * Convert arcod.xyz result to Track format.
 */
function convertArcodResult(
  value: unknown
): Track | null {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return null;
  }

  const obj =
    value as Record<string, unknown>;

  const id = obj.id;
  const title = obj.title;

  if (
    (typeof id !== "number" && typeof id !== "string") ||
    typeof title !== "string" ||
    !title.trim()
  ) {
    return null;
  }

  const trackId = String(id);

  let artist: string | undefined;

  if (
    typeof obj.performer === "object" &&
    obj.performer !== null &&
    typeof (
      obj.performer as Record<string, unknown>
    ).name === "string"
  ) {
    artist = String(
      (
        obj.performer as Record<string, unknown>
      ).name
    );
  }

  let album: string | undefined;

  if (
    typeof obj.album === "object" &&
    obj.album !== null &&
    typeof (
      obj.album as Record<string, unknown>
    ).title === "string"
  ) {
    album = String(
      (
        obj.album as Record<string, unknown>
      ).title
    );
  }

  const duration =
    typeof obj.duration === "number"
      ? obj.duration
      : undefined;

  let artworkURL: string | undefined;

  if (
    typeof obj.album === "object" &&
    obj.album !== null
  ) {
    const albumObj = obj.album as Record<string, unknown>;

    if (
      typeof albumObj.image === "object" &&
      albumObj.image !== null &&
      typeof (
        albumObj.image as Record<string, unknown>
      ).large === "string"
    ) {
      artworkURL = String(
        (
          albumObj.image as Record<string, unknown>
        ).large
      );
    }
  }

  const maxBitDepth =
    typeof obj.maximum_bit_depth === "number"
      ? obj.maximum_bit_depth
      : undefined;

  const format = maxBitDepth ? "flac" : undefined;
  const audioQuality = maxBitDepth ? "LOSSLESS" : undefined;

  // Store metadata in cache for stream logs
  trackMetadataCache.set(trackId, {
    title: title.trim(),
    artist,
    album
  });

  // Save duration for bitrate calculation
  if (
    duration &&
    duration > 0
  ) {
    trackDurationCache.set(trackId, duration);
  }

  return {
    id: trackId,
    title: title.trim(),
    artist,
    album,
    duration,
    artworkURL,
    format,
    audioQuality
  };
}

/**
 * Search arcod.xyz for tracks with retry logic.
 */
async function searchTracksArcod(
  term: string
): Promise<Track[]> {
  const url = new URL(
    `${ARCOD_BASE_URL}/api/search`
  );

  url.searchParams.set("q", term);

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[ARCOD] Search HTTP ${response.status} ${response.statusText}`
          );
          return [];
        }

        console.log(
          `[ARCOD] Search HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[ARCOD] Empty search response"
        );
        return [];
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[ARCOD] Search returned HTML:",
          payload.substring(0, 500)
        );
        return [];
      }

      const data = JSON.parse(payload);

      if (!data.success) {
        if (attempt >= MAX_RETRIES) {
          console.error(
            `[ARCOD] Search rejected: ${data.error ?? "unknown error"}`
          );
          return [];
        }

        console.log(
          `[ARCOD] Search rejected, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(data.error || "Search rejected");
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const dataObj = data.data;

      if (
        !dataObj ||
        typeof dataObj !== "object"
      ) {
        return [];
      }

      const tracks = dataObj.tracks;

      if (
        !tracks ||
        typeof tracks !== "object"
      ) {
        return [];
      }

      const items = (tracks as Record<string, unknown>).items;

      if (!Array.isArray(items)) {
        return [];
      }

      const converted: Track[] = [];

      for (const item of items) {
        const track = convertArcodResult(item);

        if (track) {
          converted.push(track);
        }
      }

      return converted;
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[ARCOD] Search request failed:",
          error
        );
        return [];
      }

      console.log(
        `[ARCOD] Search request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[ARCOD] Search failed after retries:",
    lastError
  );

  return [];
}

/**
 * Request stream from arcod.xyz with retry logic.
 */
async function requestArcodStream(
  trackId: string,
  quality: Quality,
  _atmos: string,
  durationSeconds?: number
): Promise<Stream | null> {
  const qualityId = quality === "lossless" ? "27" : "5";

  const url = new URL(
    `${ARCOD_BASE_URL}/api/player/stream/${encodeURIComponent(trackId)}`
  );

  url.searchParams.set("quality", qualityId);

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[ARCOD] Stream HTTP ${response.status} ${response.statusText}`
          );
          return null;
        }

        console.log(
          `[ARCOD] Stream HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[ARCOD] Empty stream response"
        );
        return null;
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[ARCOD] Stream returned HTML:",
          payload.substring(0, 500)
        );
        return null;
      }

      const data = JSON.parse(payload);

      if (!data.success) {
        if (attempt >= MAX_RETRIES) {
          console.error(
            `[ARCOD] Stream rejected: ${data.error ?? "unknown error"}`
          );
          return null;
        }

        console.log(
          `[ARCOD] Stream rejected, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(data.error || "Stream rejected");
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const streamUrl = data.url;

      if (
        typeof streamUrl !== "string" ||
        !/^https:\/\//i.test(streamUrl)
      ) {
        console.error(
          "[ARCOD] Invalid or missing stream URL"
        );
        return null;
      }

      const mimeType = data.mimeType;
      const format =
        typeof mimeType === "string"
          ? mimeType.split("/").pop()
          : undefined;

      const bitrateKbps =
        durationSeconds
          ? await getRemoteBitrate(
              streamUrl,
              durationSeconds
            )
          : undefined;

      const bitrate =
        bitrateKbps !== undefined
          ? bitrateKbps * 1000
          : undefined;

      return {
        url: streamUrl,
        format,
        quality:
          typeof data.quality === "number"
            ? String(data.quality)
            : quality,
        manifest: "none",
        encrypted: false,
        bitrate
      };
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[ARCOD] Stream request failed:",
          error
        );
        return null;
      }

      console.log(
        `[ARCOD] Stream request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[ARCOD] Stream failed after retries:",
    lastError
  );

  return null;
}

/**
 * Search Deezer for tracks with retry logic.
 */
async function searchTracksDeezer(
  term: string,
  quality: Quality,
  atmos: string
): Promise<Track[]> {
  const url = new URL(
    `${DEEZER_BASE_URL}/search`
  );

  url.searchParams.set("q", term);
  url.searchParams.set("quality", quality);
  url.searchParams.set("atmos", atmos);

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[DEEZER] Search HTTP ${response.status} ${response.statusText}`
          );
          return [];
        }

        console.log(
          `[DEEZER] Search HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[DEEZER] Empty search response"
        );
        return [];
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[DEEZER] Search returned HTML:",
          payload.substring(0, 500)
        );
        return [];
      }

      const data = JSON.parse(payload);

      const tracks = data.tracks ?? (Array.isArray(data) ? data : []);

      if (!Array.isArray(tracks)) {
        return [];
      }

      const converted: Track[] = [];

      for (const item of tracks) {
        const track = convertDeezerResult(item);

        if (track) {
          converted.push(track);
        }
      }

      return converted;
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[DEEZER] Search request failed:",
          error
        );
        return [];
      }

      console.log(
        `[DEEZER] Search request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[DEEZER] Search failed after retries:",
    lastError
  );

  return [];
}

/**
 * Request stream from Deezer with retry logic.
 */
async function requestDeezerStream(
  trackId: string,
  quality: Quality,
  atmos: string,
  durationSeconds?: number
): Promise<Stream | null> {
  // Validate track ID format
  if (!/^[A-Za-z0-9_-]+$/.test(trackId)) {
    console.error(
      "[DEEZER] Invalid track ID format"
    );
    return null;
  }

  const url = new URL(
    `${DEEZER_BASE_URL}/stream/${encodeURIComponent(trackId)}`
  );

  url.searchParams.set("quality", quality);
  url.searchParams.set("atmos", atmos);

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[DEEZER] Stream HTTP ${response.status} ${response.statusText}`
          );
          return null;
        }

        console.log(
          `[DEEZER] Stream HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload = await response.text();

      if (!payload) {
        console.error(
          "[DEEZER] Empty stream response"
        );
        return null;
      }

      if (payload.trim().startsWith("<")) {
        console.error(
          "[DEEZER] Stream returned HTML:",
          payload.substring(0, 500)
        );
        return null;
      }

      const data = JSON.parse(payload);

      const streamUrl = data.url;

      if (
        typeof streamUrl !== "string" ||
        !/^https:\/\//i.test(streamUrl)
      ) {
        console.error(
          "[DEEZER] Invalid or missing stream URL"
        );
        return null;
      }

      const bitrateKbps =
        durationSeconds
          ? await getRemoteBitrate(
              streamUrl,
              durationSeconds
            )
          : undefined;

      const bitrate =
        bitrateKbps !== undefined
          ? bitrateKbps * 1000
          : undefined;

      return {
        url: streamUrl,
        format:
          typeof data.format === "string"
            ? data.format
            : undefined,
        quality:
          typeof data.quality === "string"
            ? data.quality
            : quality,
        codec:
          typeof data.codec === "string"
            ? data.codec
            : undefined,
        container:
          typeof data.container === "string"
            ? data.container
            : undefined,
        manifest:
          data.manifest === "hls" ||
          data.manifest === "dash"
            ? data.manifest
            : "none",
        encrypted: data.encrypted === true,
        sampleRate:
          typeof data.sampleRate === "number"
            ? data.sampleRate
            : undefined,
        bitDepth:
          typeof data.bitDepth === "number"
            ? data.bitDepth
            : undefined,
        bitrate
      };
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[DEEZER] Stream request failed:",
          error
        );
        return null;
      }

      console.log(
        `[DEEZER] Stream request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[DEEZER] Stream failed after retries:",
    lastError
  );

  return null;
}

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
async function getRemoteBitrate(
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

/**
 * Request stream from Qobuz-DL with retry logic.
 */
async function requestQobuzDLStream(
  trackId: string,
  qualityCode: number,
  durationSeconds?: number
): Promise<Stream | null> {
  const url = new URL(
    `${QOBUZ_DL_BASE_URL}/api/download-music`
  );

  url.searchParams.set(
    "track_id",
    trackId
  );

  url.searchParams.set(
    "quality",
    String(qualityCode)
  );

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_USER_AGENT
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
          console.error(
            `[QOBUZ-DL] Stream HTTP ${response.status} ${response.statusText}`
          );
          return null;
        }

        console.log(
          `[QOBUZ-DL] Stream HTTP ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(`HTTP ${response.status}`);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const payload =
        await response.text();

      if (!payload) {
        console.error(
          "[QOBUZ-DL] Empty stream response"
        );
        return null;
      }

      if (
        payload.trim().startsWith("<")
      ) {
        console.error(
          "[QOBUZ-DL] Stream returned HTML:",
          payload.substring(0, 500)
        );
        return null;
      }

      const data =
        JSON.parse(payload);

      if (!data.success) {
        const apiError =
          data.error;

        const message =
          apiError
            ?.toLowerCase()
            .includes("captcha")
            ? "Qobuz-DL requires a browser captcha right now"
            : `Qobuz-DL rejected quality ${qualityCode}: ${
                apiError ?? "unknown error"
              }`;

        if (attempt >= MAX_RETRIES) {
          console.error(
            `[QOBUZ-DL] ${message}`
          );
          return null;
        }

        console.log(
          `[QOBUZ-DL] ${message}, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        lastError = new Error(message);
        await delay(200 * Math.pow(2, attempt));
        continue;
      }

      const streamUrl =
        data.data?.url;

      if (!streamUrl) {
        console.error(
          `[QOBUZ-DL] No stream URL for quality ${qualityCode}`
        );
        return null;
      }

      const bitDepth =
        data.data?.bit_depth;

      const samplingRate =
        data.data?.sampling_rate;

      const sampleRateHz =
        samplingRate
          ? Math.round(
              samplingRate * 1000
            )
          : undefined;

      const hires =
        (bitDepth ?? 0) > 16 ||
        (samplingRate ?? 0) > 44.1 ||
        qualityCode >= 7;

      const qualityLabel =
        hires
          ? `Hi-Res ${
              bitDepth ?? 24
            }-bit / ${
              sampleRateHz ?? 96000
            } Hz`
          : qualityCode === 5
            ? "High"
            : "Lossless";

      /*
       * Calculate average compressed FLAC bitrate.
       *
       * getRemoteBitrate() returns kbps.
       * BitChord accepts bits per second or kbps,
       * but returning bits per second avoids ambiguity.
       */
      const bitrateKbps =
        durationSeconds
          ? await getRemoteBitrate(
              streamUrl,
              durationSeconds
            )
          : undefined;

      const bitrate =
        bitrateKbps !== undefined
          ? bitrateKbps * 1000
          : undefined;

      return {
        url: streamUrl,

        format: "flac",

        quality: qualityLabel,

        codec: "flac",

        container: "flac",

        manifest: "none",

        encrypted: false,

        sampleRate: sampleRateHz,

        bitDepth,

        bitrate
      };
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= MAX_RETRIES) {
        console.error(
          "[QOBUZ-DL] Stream request failed:",
          error
        );
        return null;
      }

      console.log(
        `[QOBUZ-DL] Stream request failed, retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      lastError = error;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  console.error(
    "[QOBUZ-DL] Stream failed after retries:",
    lastError
  );

  return null;
}

export class AuthorizedProvider
  implements MusicProvider
{
  getTrackMetadata(id: string): {title: string, artist?: string, album?: string} | undefined {
    // Parse source prefix
    const separator = id.indexOf(':');
    const trackId = separator > 0 ? id.slice(separator + 1) : id;

    return trackMetadataCache.get(trackId);
  }
  async search(
    query: string,
    quality: Quality,
    atmos: string
  ): Promise<Track[]> {
    const key =
      cacheKey(
        query,
        quality
      );

    const cached =
      getCached(key);

    if (cached) {
      console.log(
        `[SEARCH] Cache hit for "${query}"`
      );
      return cached;
    }

    // Try Qobuz-DL first (best 24-bit support)
    console.log(
      `[SEARCH] Trying Qobuz-DL for "${query}"`
    );

    const qobuzResults =
      await searchTracksQobuzDL(
        query
      );

    if (qobuzResults.length > 0) {
      // Add source prefix to track IDs
      const prefixed = qobuzResults.map(track => ({
        ...track,
        id: `qobuzdl:${track.id}`
      }));

      // Score and rank results
      const scored: ScoredTrack[] = prefixed.map(track => ({
        track,
        score: scoreTrack(query, track)
      }));

      // Filter out poor matches (score < -500)
      const filtered = scored.filter(s => s.score >= -500);

      // Sort by score descending
      filtered.sort((a, b) => b.score - a.score);

      const ranked = filtered.map(s => s.track);

      setCached(
        key,
        ranked
      );

      console.log(
        `[SEARCH] Qobuz-DL returned ${ranked.length} tracks for "${query}"`
      );

      return ranked;
    }

    // Fallback to arcod.xyz (alternate Qobuz with 24-bit support)
    console.log(
      `[SEARCH] Qobuz-DL returned no results, trying arcod.xyz for "${query}"`
    );

    const arcodResults =
      await searchTracksArcod(
        query
      );

    if (arcodResults.length > 0) {
      // Add source prefix to track IDs
      const prefixed = arcodResults.map(track => ({
        ...track,
        id: `arcod:${track.id}`
      }));

      // Score and rank results
      const scored: ScoredTrack[] = prefixed.map(track => ({
        track,
        score: scoreTrack(query, track)
      }));

      // Filter out poor matches (score < -500)
      const filtered = scored.filter(s => s.score >= -500);

      // Sort by score descending
      filtered.sort((a, b) => b.score - a.score);

      const ranked = filtered.map(s => s.track);

      setCached(
        key,
        ranked
      );

      console.log(
        `[SEARCH] arcod.xyz returned ${ranked.length} tracks for "${query}"`
      );

      return ranked;
    }

    // Fallback to Monochrome
    console.log(
      `[SEARCH] arcod.xyz returned no results, trying Monochrome for "${query}"`
    );

    const monochromeResults =
      await searchTracksMonochrome(
        query
      );

    if (monochromeResults.length > 0) {
      // Add source prefix to track IDs
      const prefixed = monochromeResults.map(track => ({
        ...track,
        id: `monochrome:${track.id}`
      }));

      // Score and rank results
      const scored: ScoredTrack[] = prefixed.map(track => ({
        track,
        score: scoreTrack(query, track)
      }));

      // Filter out poor matches (score < -500)
      const filtered = scored.filter(s => s.score >= -500);

      // Sort by score descending
      filtered.sort((a, b) => b.score - a.score);

      const ranked = filtered.map(s => s.track);

      setCached(
        key,
        ranked
      );

      console.log(
        `[SEARCH] Monochrome returned ${ranked.length} tracks for "${query}"`
      );

      return ranked;
    }

    // Fallback to Deezer
    console.log(
      `[SEARCH] Monochrome returned no results, trying Deezer for "${query}"`
    );

    const deezerResults =
      await searchTracksDeezer(
        query,
        quality,
        atmos
      );

    if (deezerResults.length > 0) {
      // Add source prefix to track IDs
      const prefixed = deezerResults.map(track => ({
        ...track,
        id: `deezer:${track.id}`
      }));

      // Score and rank results
      const scored: ScoredTrack[] = prefixed.map(track => ({
        track,
        score: scoreTrack(query, track)
      }));

      // Filter out poor matches (score < -500)
      const filtered = scored.filter(s => s.score >= -500);

      // Sort by score descending
      filtered.sort((a, b) => b.score - a.score);

      const ranked = filtered.map(s => s.track);

      setCached(
        key,
        ranked
      );

      console.log(
        `[SEARCH] Deezer returned ${ranked.length} tracks for "${query}"`
      );

      return ranked;
    }

    // Fallback to LastBabe
    console.log(
      `[SEARCH] Deezer returned no results, trying LastBabe for "${query}"`
    );

    const lastBabeResults =
      await searchTracksLastBabe(
        query
      );

    if (lastBabeResults.length === 0) {
      return [];
    }

    // Add source prefix to track IDs
    const prefixed = lastBabeResults.map(track => ({
      ...track,
      id: `lastbabe:${track.id}`
    }));

    // Score and rank results
    const scored: ScoredTrack[] = prefixed.map(track => ({
      track,
      score: scoreTrack(query, track)
    }));

    // Filter out poor matches (score < -500)
    const filtered = scored.filter(s => s.score >= -500);

    // Sort by score descending
    filtered.sort((a, b) => b.score - a.score);

    const ranked = filtered.map(s => s.track);

    setCached(
      key,
      ranked
    );

    console.log(
      `[SEARCH] LastBabe returned ${ranked.length} tracks for "${query}"`
    );

    return ranked;
  }

  async findByIsrc(
    isrc: string,
    quality: Quality
  ): Promise<Track | null> {
    const results =
      await searchTracksQobuzDL(
        isrc
      );

    /*
     * Compare against the actual ISRC field,
     * not the Qobuz numeric track ID.
     */
    const exactMatch =
      results.find(
        track =>
          track.isrc?.toLowerCase() ===
          isrc.toLowerCase()
      );

    return exactMatch || null;
  }

  async getStream(
    id: string,
    quality: Quality,
    _atmos: string
  ): Promise<Stream | null> {
    // Parse source prefix
    const separator = id.indexOf(':');
    let source: string;
    let trackId: string;

    if (separator > 0) {
      source = id.slice(0, separator);
      trackId = id.slice(separator + 1);
    } else {
      // No prefix, assume Qobuz-DL for backward compatibility
      source = 'qobuzdl';
      trackId = id;
    }

    /*
     * Retrieve the duration saved when BitChord
     * searched for the track.
     */
    const duration =
      trackDurationCache.get(trackId);

    if (source === 'monochrome') {
      const stream =
        await requestMonochromeStream(
          trackId,
          quality,
          _atmos,
          duration
        );

      return stream;
    } else if (source === 'qobuzdl') {
      const formatId =
        qualityToFormatId(
          quality
        );

      const stream =
        await requestQobuzDLStream(
          trackId,
          formatId,
          duration
        );

      return stream;
    } else if (source === 'arcod') {
      const stream =
        await requestArcodStream(
          trackId,
          quality,
          _atmos,
          duration
        );

      return stream;
    } else if (source === 'deezer') {
      const stream =
        await requestDeezerStream(
          trackId,
          quality,
          _atmos,
          duration
        );

      return stream;
    } else if (source === 'lastbabe') {
      const stream =
        await requestLastBabeStream(
          trackId,
          quality,
          duration
        );

      return stream;
    } else {
      console.error(
        `[STREAM] Unknown source prefix: ${source}`
      );
      return null;
    }
  }
}