import express, { Request, Response, NextFunction } from "express";
import { AuthorizedProvider } from "./provider";
import { Quality } from "./types";

const app = express();
const provider = new AuthorizedProvider();

const PORT = Number(process.env.PORT || 4000);

app.disable("x-powered-by");
app.use(express.json());

const MANIFEST = {
  id: "kaleb.bitchord.music",
  name: "Qobuz HiFi",
  version: "1.0.0",
  resources: [
    "search",
    "stream"
  ],
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

app.use(
  (req: Request, _res: Response, next: NextFunction) => {
    const timestamp = new Date().toISOString();

    console.log(
      `[${timestamp}] ${req.method} ${req.originalUrl}`
    );

    next();
  }
);

function getQuality(value: unknown): Quality {
  switch (String(value || "").toLowerCase()) {
    case "high":
      return "high";

    case "low":
      return "low";

    case "lossless":
    default:
      return "lossless";
  }
}

app.get(
  "/manifest.json",
  (_req: Request, res: Response) => {
    res.setHeader(
      "Cache-Control",
      "public, max-age=300"
    );

    return res.json(MANIFEST);
  }
);

app.get(
  "/search",
  async (req: Request, res: Response) => {
    const query = String(
      req.query.q || ""
    ).trim();

    const quality = getQuality(
      req.query.quality
    );

    const atmos = String(
      req.query.atmos || "auto"
    );

    if (!query) {
      return res.json({
        tracks: []
      });
    }

    try {
      const tracks =
        await provider.search(
          query,
          quality,
          atmos
        );

      if (tracks.length === 0) {
        console.log(
          `[SEARCH] Not found - no tracks for "${query}"`
        );
      } else {
        console.log(
          `[SEARCH] Success - returned ${tracks.length} tracks for "${query}"`
        );
      }

      return res.json({
        tracks
      });
    } catch (error) {
      console.error(
        "[SEARCH] Provider error:",
        error
      );

      return res.status(500).json({
        tracks: [],
        error: "Search failed"
      });
    }
  }
);

app.get(
  "/stream/:id",
  async (req: Request, res: Response) => {
    const rawId = req.params.id;

    const id = decodeURIComponent(
      Array.isArray(rawId)
        ? rawId[0]
        : rawId
    );

    const quality = getQuality(
      req.query.quality
    );

    const atmos = String(
      req.query.atmos || "auto"
    );

    if (!id) {
      return res.status(400).json({
        error: "Missing track ID"
      });
    }

    try {
      const stream =
        await provider.getStream(
          id,
          quality,
          atmos
        );

      // Get song name for logging
      const metadata = provider.getTrackMetadata(id);
      const songName = metadata?.title || "Unknown Track";

      if (!stream) {
        console.log(
          `[STREAM] Not found - no stream for "${songName}" (track ${id})`
        );
        return res.status(404).send();
      }

      if (!stream.url) {
        console.log(
          `[STREAM] Not found - no URL for "${songName}" (track ${id})`
        );
        return res.status(404).send();
      }

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      console.log(
        `[STREAM] Success - returning stream for "${songName}" (track ${id})`
      );

      return res.json(stream);
    } catch (error) {
      console.error(
        `[STREAM] Provider error for "${id}":`,
        error
      );

      return res.status(500).json({
        error: "Stream resolution failed"
      });
    }
  }
);

app.get(
  "/health",
  (_req: Request, res: Response) => {
    return res.json({
      status: "ok",
      service: "bitchord-addon",
      version: MANIFEST.version,
      timestamp: new Date().toISOString()
    });
  }
);

app.get(
  "/",
  (_req: Request, res: Response) => {
    return res.json({
      name: MANIFEST.name,
      version: MANIFEST.version,
      status: "online",
      endpoints: [
        "/manifest.json",
        "/search",
        "/stream/:id",
        "/health"
      ]
    });
  }
);

app.use(
  (_req: Request, res: Response) => {
    return res.status(404).json({
      error: "Not found"
    });
  }
);

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    console.error(
      "[ERROR] Unhandled server error:",
      error
    );

    return res.status(500).json({
      error: "Internal server error"
    });
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "       BitChord Music Addon"
    );
    console.log(
      "========================================"
    );
    console.log(`Port: ${PORT}`);
    console.log(
      `Manifest: http://localhost:${PORT}/manifest.json`
    );
    console.log(
      `Search:   http://localhost:${PORT}/search?q=test`
    );
    console.log(
      `Health:   http://localhost:${PORT}/health`
    );
    console.log(
      "========================================"
    );
    console.log("");
  }
);

// For local development
if (require.main === module) {
  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "       BitChord Music Addon"
      );
      console.log(
        "========================================"
      );
      console.log(`Port: ${PORT}`);
      console.log(
        `Manifest: http://localhost:${PORT}/manifest.json`
      );
      console.log(
        `Search:   http://localhost:${PORT}/search?q=test`
      );
      console.log(
        `Health:   http://localhost:${PORT}/health`
      );
      console.log(
        "========================================"
      );
      console.log("");
    }
  );
}
