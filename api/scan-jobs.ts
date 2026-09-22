import { scanJobsForEmployer } from "./_lib/gemini-jobs";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { employerName, website, existingTitles } = req.body || {};
  if (!employerName) {
    return res.status(400).json({ error: "Employer Name is required." });
  }
  const result = await scanJobsForEmployer(employerName, website, existingTitles);
  if ("error" in result) {
    return res.status(400).json(result);
  }
  return res.status(200).json(result);
}
