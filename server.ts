import "dotenv/config";
import dns from "dns";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { hasGeminiApiKey, scanJobsForEmployer } from "./api/_lib/gemini-jobs.js";

dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "100kb" }));

app.get("/api/gemini-status", (_req, res) => {
  res.json({ configured: hasGeminiApiKey() });
});

app.post("/api/scan-jobs", async (req, res) => {
  const employerName = String(req.body?.employerName || "").trim();
  const website = String(req.body?.website || "").trim();
  const existingTitles = Array.isArray(req.body?.existingTitles) ? req.body.existingTitles : [];

  if (!employerName) {
    return res.status(400).json({ error: "Employer Name is required.", jobs: [] });
  }

  try {
    const result = await scanJobsForEmployer(employerName, website, existingTitles);
    if (result.error) return res.status(400).json(result);
    return res.json(result);
  } catch (error: any) {
    console.error("[scan-jobs handler error]:", error);
    return res.status(500).json({ error: error?.message || "Failed to scan jobs", jobs: [] });
  }
});

async function setupVite() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

setupVite().catch((error) => {
  console.error("Failed to start Vite dev server wrapper:", error);
});
