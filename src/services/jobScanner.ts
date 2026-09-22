import { GoogleGenAI } from "@google/genai";

// Initialize Gemini API client using Vite environment variable
const ai = new GoogleGenAI({
  apiKey: import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || ''
});

export function isGeminiConfigured(): boolean {
  const key = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  return Boolean(key && key.trim().length > 0);
}

export interface ScannedJob {
  title: string;
  location?: string;
  city?: string;
  roleType?: string;
  url?: string;
  postedDate?: string;
  description?: string;
}

/**
 * Scans an employer website by fetching clean markdown via Jina Reader
 * and extracting active job openings using Gemini 2.0 Flash.
 */
export async function scanJobsForEmployer(
  employerName: string,
  websiteUrl: string,
  existingTitles: string[] = []
): Promise<ScannedJob[]> {
  if (!websiteUrl || !websiteUrl.startsWith("http")) {
    console.warn(`[JobScanner] Invalid website URL for ${employerName}: ${websiteUrl}`);
    return [];
  }

  try {
    // 1. Fetch clean markdown content via Jina Reader (bypasses browser CORS)
    const jinaUrl = `https://r.jina.ai/${encodeURIComponent(websiteUrl.trim())}`;
    const response = await fetch(jinaUrl, {
      headers: { "Accept": "text/markdown" }
    });

    if (!response.ok) {
      console.warn(`[JobScanner] Jina fetch failed for ${employerName} (${response.status})`);
      return [];
    }

    const markdownText = await response.text();

    // 2. Truncate text to ~8,000 chars to protect free-tier rate limits
    const truncatedText = markdownText.slice(0, 8000);

    if (!truncatedText || truncatedText.length < 50) {
      console.warn(`[JobScanner] No usable text extracted from ${websiteUrl}`);
      return [];
    }

    // 3. Prompt Gemini 2.0 Flash to extract job listings
    const prompt = `
You are an expert workforce development crawler extracting job openings for "${employerName}".

Analyze the raw web content below and extract all active job postings listed.

Return ONLY a valid JSON array of objects with these exact keys:
- "title": Job title (required)
- "location": Full location string (e.g. "Philadelphia, PA")
- "city": City name (e.g. "Philadelphia")
- "roleType": One of ["Full-time", "Part-time", "Contract", "Temporary", "Unknown"]
- "url": Direct link to job application (use "${websiteUrl}" if specific link not found)
- "description": Brief 1-2 sentence description of the role

Do not include roles that match these existing titles if present: ${JSON.stringify(existingTitles.slice(0, 20))}

Page Content:
${truncatedText}
`;

    const aiResponse = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const rawJson = aiResponse.text;
    if (!rawJson) return [];

    const parsedJobs: ScannedJob[] = JSON.parse(rawJson);
    return Array.isArray(parsedJobs) ? parsedJobs : [];

  } catch (error) {
    console.error(`[JobScanner] Failed scanning ${employerName}:`, error);
    return [];
  }
}
