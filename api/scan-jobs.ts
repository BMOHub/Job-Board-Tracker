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

    // Check if scanJobsForEmployer returned an error
    if (result && result.error) {
      return res.status(400).json(result);
    }

    // Check if result is an object containing a jobs array { jobs: [...], source: "..." }
    if (result && Array.isArray(result.jobs)) {
      return res.status(200).json(result);
    }

    // Fallback if result is a direct array [...]
    if (Array.isArray(result)) {
      return res.status(200).json({ jobs: result });
    }

    return res.status(200).json({ jobs: [] });
  } catch (error: any) {
    console.error("[scan-jobs handler error]:", error);
    return res.status(500).json({ error: error.message || "Failed to scan jobs", jobs: [] });
  }
}
