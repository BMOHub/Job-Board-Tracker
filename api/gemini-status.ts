import { hasGeminiApiKey } from './_lib/gemini-jobs.js';

export default async function handler(req: any, res: any) {
  try {
    return res.status(200).json({
      status: "ok",
      configured: hasGeminiApiKey(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      error: error?.message || "Internal status check error",
    });
  }
}
