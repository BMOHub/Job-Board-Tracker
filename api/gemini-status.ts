import { isGeminiConfigured } from "./_lib/gemini-jobs.js";

export default function handler(req: any, res: any) {
  res.status(200).json({ configured: isGeminiConfigured() });
}
