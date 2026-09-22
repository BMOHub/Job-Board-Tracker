import { scanJobsForEmployer } from "./_lib/gemini-jobs.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { employerName, website, websiteUrl, existingTitles } = req.body || {};
  const targetUrl = website || websiteUrl || "";

  if (!employerName) {
    return res.status(400).json({ error: "Employer Name is required." });
  }

  try {
    const result: any = await scanJobsForEmployer(employerName, targetUrl, existingTitles || []);

    if (result && typeof result === "object" && "error" in result) {
      return res.status(400).json(result);
    }

    const jobsList = Array.isArray(result?.jobs)
      ? result.jobs
      : (Array.isArray(result) ? result : []);

    return res.status(200).json({ jobs: jobsList, source: result?.source });
  } catch (error: any) {
    console.error("[scan-jobs handler error]:", error);
    return res.status(500).json({ error: error.message || "Failed to scan jobs", jobs: [] });
  }
}
