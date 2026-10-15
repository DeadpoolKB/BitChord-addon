import { createServer } from 'http';
import express from 'express';
import { AuthorizedProvider } from '../src/provider';

const app = express();
const provider = new AuthorizedProvider();

app.disable("x-powered-by");
app.use(express.json());

const MANIFEST = {
  id: "kaleb.bitchord.music",
  name: "Qobuz HiFi",
  version: "1.0.0",
  resources: ["search", "stream"],
  allowDownloads: 0,
  settings: [
    {
      key: "quality",
      type: "select",
      default: "lossless",
      options: [
        { label: "Lossless", value: "lossless" },
        { label: "High", value: "high" },
        { label: "Low", value: "low" }
      ]
    }
  ]
};

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.originalUrl}`);
  next();
});

function getQuality(value: unknown): "lossless" | "high" | "low" {
  switch (String(value || "").toLowerCase()) {
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "lossless";
  }
}

app.get("/manifest.json", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.json(MANIFEST);
});

app.get("/search", async (req, res) => {
  const { q, quality, atmos } = req.query;

  if (!q) {
    return res.status(400).json({ error: "Missing query" });
  }

  const qualityParam = getQuality(quality);
  const atmosParam = atmos || "auto";

  try {
    const results = await provider.search(q as string, qualityParam, atmosParam as string);

    if (results.length === 0) {
      console.log(`[SEARCH] Not found - no tracks for "${q}"`);
      return res.json({ tracks: [] });
    }

    console.log(`[SEARCH] Success - returned ${results.length} tracks for "${q}"`);
    return res.json({ tracks: results });
  } catch (error) {
    console.error(`[SEARCH] Error for "${q}":`, error);
    return res.status(500).json({ error: "Search failed" });
  }
});

app.get("/stream/:id", async (req, res) => {
  const { id } = req.params;
  const { quality, atmos } = req.query;

  if (!id) {
    return res.status(400).json({ error: "Missing track ID" });
  }

  const qualityParam = getQuality(quality);
  const atmosParam = atmos || "auto";

  try {
    const stream = await provider.getStream(id as string, qualityParam, atmosParam as string);

    const metadata = provider.getTrackMetadata(id as string);
    const songName = metadata?.title || "Unknown Track";

    if (!stream) {
      console.log(`[STREAM] Not found - no stream for "${songName}" (track ${id})`);
      return res.status(404).send();
    }

    if (!stream.url) {
      console.log(`[STREAM] Not found - no URL for "${songName}" (track ${id})`);
      return res.status(404).send();
    }

    res.setHeader("Cache-Control", "no-store");
    console.log(`[STREAM] Success - returning stream for "${songName}" (track ${id})`);
    return res.json(stream);
  } catch (error) {
    console.error(`[STREAM] Provider error for "${id}":`, error);
    return res.status(500).json({ error: "Stream resolution failed" });
  }
});

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "bitchord-addon",
    version: MANIFEST.version,
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  return res.json({
    name: MANIFEST.name,
    version: MANIFEST.version,
    status: "online",
    endpoints: ["/manifest.json", "/search", "/stream/:id", "/health"]
  });
});

app.use((req, res) => {
  return res.status(404).json({ error: "Not found" });
});

app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[ERROR] Unhandled server error:", error);
  return res.status(500).json({ error: "Internal server error" });
});

export default app;
