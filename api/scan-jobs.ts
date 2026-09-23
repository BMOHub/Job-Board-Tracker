import { scanJobsForEmployer } from "./_lib/gemini-jobs.js";

export default async function handler(req: any, res: any) {
  // Allow both POST and GET for easy debugging
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Extract parameters from body (POST) or query string (GET)
  const input = req.method === "POST" ? (req.body || {}) : (req.query || {});
  
  const employerName = input.employerName || input.name || input.employer || "";
  const website = input.website || input.url || input.websiteUrl || "";
  const existingTitles = input.existingTitles || [];

  if (!employerName) {
    return res.status(400).json({ error: "Employer Name is required.", jobs: [] });
  }

  try {
    const result: any = await scanJobsForEmployer(employerName, website, existingTitles);

    if (result.error) {
      const errorMessage = String(result.error).toLowerCase();
      const status = /quota|rate limit/.test(errorMessage)
        ? 429
        : /rejected the configured api key/.test(errorMessage)
          ? 401
          : /denied access/.test(errorMessage)
            ? 403
            : /timed out/.test(errorMessage)
              ? 504
              : 502;
      return res.status(status).json(result);
    }
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[scan-jobs handler error]:", error);
    return res.status(500).json({ error: error.message || "Failed to scan jobs", jobs: [] });
  }
}
