import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || "";
    const isConfigured = !!apiKey && apiKey !== "MY_GEMINI_API_KEY";

    return res.status(200).json({
      status: "ok",
      geminiConfigured: isConfigured,
      keyPrefix: apiKey ? `${apiKey.substring(0, 6)}...` : "none",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      error: error?.message || "Internal status check error",
    });
  }
}
