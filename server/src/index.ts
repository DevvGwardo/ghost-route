import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";
import { healthPayload } from "./routes/system.js";
import { apiLimiter, routeLimiter, cameraWriteLimiter, noKeyLeak } from "./security.js";

export const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(apiLimiter);
app.use("/api/route", routeLimiter);
app.use(express.json({ limit: "100kb" }));
// Malformed JSON bodies → shaped 400 (before the generic 500 handler).
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { type?: string }).type === "entity.parse.failed"
    ) {
      res.status(400).json({ error: "invalid-json" });
      return;
    }
    next(err);
  },
);

app.get("/api/health", (req, res) => {
  res.json(healthPayload(req.header("x-typesafe-key") ?? undefined));
});

// Routers owned by the api agent; skip gracefully until they land.
async function mount(specifier: string, prefix: string): Promise<void> {
  try {
    const mod = (await import(specifier)) as {
      default?: unknown;
      router?: unknown;
    };
    const router = mod.default ?? mod.router;
    if (router) app.use(prefix, router as express.Router);
  } catch {
    // Route file not present yet — health endpoint still serves.
  }
}

await mount("./routes/cameras.js", "/api/cameras");
await mount("./routes/route.js", "/api/route");
await mount("./routes/system.js", "/api/system");

// Error handler last: generic 500, no stack, no leaked keys.
app.use(noKeyLeak);

const PORT = Number(process.env.PORT) || 8801;
const isMain =
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, () => {
    console.log(`ghost-route server on :${PORT}`);
  });
}
