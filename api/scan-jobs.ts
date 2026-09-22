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

    if (result && typeof result === "object" && "error" in result && !result.jobs) {
      return res.status(400).json(result);
    }

    const jobsList = Array.isArray(result?.jobs)
      ? result.jobs
      : (Array.isArray(result) ? result : []);

    // Return the response in both formats to guarantee the frontend UI catches it
    return res.status(200).json({
      success: true,
      jobs: jobsList,
      source: result?.source || "live-scrape"
    });
  } catch (error: any) {
    console.error("[scan-jobs handler error]:", error);
    return res.status(500).json({ error: error.message || "Failed to scan jobs", jobs: [] });
  }
}
