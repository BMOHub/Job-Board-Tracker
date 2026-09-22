import { GoogleGenAI, Type } from "@google/genai";

export interface ScannedJob {
  title: string;
  url: string;
  location: string;
  city: string;
  roleType: string;
  postedDate: string;
  description: string;
}

const getApiKey = () => process.env.GEMINI_API_KEY || "";

export const isGeminiConfigured = () => {
  const key = getApiKey();
  return !!key && key !== "MY_GEMINI_API_KEY";
};

let aiInstance: GoogleGenAI | null = null;
const getAI = () => {
  if (!aiInstance) {
    const key = getApiKey();
    if (key) {
      aiInstance = new GoogleGenAI({
        apiKey: key,
        httpOptions: { headers: { "User-Agent": "aistudio-build" } },
      });
    }
  }
  return aiInstance;
};

/**
 * Resolves URLs and attempts to match with Google Search Grounding URIs if available.
 */
function findBestJobUrl(
  rawUrl: string,
  jobTitle: string,
  baseUrl: string,
  groundingChunks: any[] = []
): string {
  let url = (rawUrl || "").trim();

  // Match title against Google Search Grounding links if present
  if (Array.isArray(groundingChunks) && groundingChunks.length > 0) {
    const validUris = groundingChunks
      .map((c) => ({ uri: c?.web?.uri || "", title: c?.web?.title || "" }))
      .filter((item) => item.uri && item.uri.startsWith("http"));
    
    const titleWords = jobTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

    for (const chunk of validUris) {
      const chunkUri = chunk.uri.toLowerCase();
      const chunkTitle = chunk.title.toLowerCase();
      const matchesTitle = titleWords.some((w) => chunkTitle.includes(w) || chunkUri.includes(w));
      if (matchesTitle) return chunk.uri;
    }
  }

  if (!url) return baseUrl;

  // Resolve relative links (e.g. "/get-involved/join-our-team")
  if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("mailto:")) {
    try {
      const base = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
      url = new URL(url, base).href;
    } catch (e) {
      return baseUrl;
    }
  }

  return url;
}

function sanitizeJobsArray(arr: any[], baseUrl = "", groundingChunks: any[] = []): ScannedJob[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && typeof item.title === "string")
    .map((item) => {
      const title = String(item.title || "").trim();
      const rawUrl = String(item.url || "").trim();
      const finalUrl = findBestJobUrl(rawUrl, title, baseUrl, groundingChunks);
      return {
        title,
        url: finalUrl,
        location: String(item.location || "Philadelphia, PA").trim(),
        city: String(item.city || "Philadelphia").trim(),
        roleType: String(item.roleType || "Full-time").trim(),
        postedDate: String(item.postedDate || "").trim(),
        description: String(item.description || "").trim(),
      };
    })
    .filter((item) => item.title.length > 0);
}

function parseAndCleanJobsJson(rawText: string, baseUrl = "", groundingChunks: any[] = []): ScannedJob[] {
  if (!rawText || typeof rawText !== "string") return [];
  let text = rawText.trim();
  
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, baseUrl, groundingChunks);
    if (parsed && Array.isArray(parsed.jobs)) return sanitizeJobsArray(parsed.jobs, baseUrl, groundingChunks);
  } catch (e) {}

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const arrayStr = text.substring(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, baseUrl, groundingChunks);
    } catch (e) {}
  }

  return [];
}

/**
 * Engine 1: Extracts jobs from direct webpage markdown.
 */
async function extractJobsFromMarkdown(
  ai: GoogleGenAI,
  employerName: string,
  websiteUrl: string,
  markdownText: string,
  existingTitlesStr: string
): Promise<ScannedJob[]> {
  if (!markdownText || markdownText.length < 100) return [];

  const prompt = `You are an expert workforce crawler extracting active, real job openings for "${employerName}" in Greater Philadelphia.

Analyze the raw web content below to extract actual open job positions and internships.

URL EXTRACTION RULES:
- Inspect every Markdown link [Job Title](href) or application link in the content.
- If a direct job URL or relative link exists (e.g., "/get-involved/join-our-team" or "mailto:careers@wacphila.org"), extract it.
- Default to "${websiteUrl}" if no specific job application link is present.

Official Reference Website: ${websiteUrl}${existingTitlesStr}

Page Content:
${markdownText}

Return a JSON array of active openings listed on this page.
Each object MUST contain:
- "title": Exact Job Title
- "url": Application or detail link
- "location": Location (e.g., "Philadelphia, PA")
- "city": City name (e.g., "Philadelphia")
- "roleType": "Full-time", "Part-time", "Contract", or "Internship"
- "postedDate": Date posted (YYYY-MM-DD)
- "description": 1-2 sentence description of key duties.`;

  const schemaConfig = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        url: { type: Type.STRING },
        location: { type: Type.STRING },
        city: { type: Type.STRING },
        roleType: { type: Type.STRING },
        postedDate: { type: Type.STRING },
        description: { type: Type.STRING },
      },
      required: ["title", "url", "location", "city", "roleType"],
    },
  };

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: schemaConfig },
    });

    if (response && response.text) {
      return parseAndCleanJobsJson(response.text, websiteUrl);
    }
  } catch (error) {
    console.error("[gemini-jobs markdown extraction error]:", error);
  }

  return [];
}

/**
 * Engine 2: Fallback using Google Search Grounding to search live web index.
 */
async function searchJobsViaGoogleGrounding(
  ai: GoogleGenAI,
  employerName: string,
  websiteUrl: string,
  existingTitlesStr: string
): Promise<ScannedJob[]> {
  const prompt = `Find active job openings, careers, and internships for "${employerName}" in Greater Philadelphia.

Search official website ${websiteUrl} and careers portals.${existingTitlesStr}

Return ONLY a JSON array of active job objects.
Each object MUST contain:
- "title": Exact Job Title
- "url": Direct application URL or careers link
- "location": Location (e.g. "Philadelphia, PA")
- "city": City name (e.g. "Philadelphia")
- "roleType": "Full-time", "Part-time", "Contract", or "Internship"
- "postedDate": Date posted (YYYY-MM-DD)
- "description": 1-2 sentence description.

Return strictly a JSON array in backticks:
\`\`\`json
[
  { "title": "...", "url": "...", "location": "Philadelphia, PA", "city": "Philadelphia", "roleType": "Full-time", "postedDate": "2026-09-22", "description": "..." }
]
\`\`\``;

  try {
    const response: any = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    if (response && response.text) {
      const groundingChunks = (response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks || [];
      return parseAndCleanJobsJson(response.text, websiteUrl, groundingChunks);
    }
  } catch (error) {
    console.error("[gemini-jobs search grounding error]:", error);
  }

  return [];
}

export async function scanJobsForEmployer(employerName: string, website: string, existingTitles: string[]) {
  const ai = getAI();
  if (!ai) {
    return { error: "GEMINI_API_KEY is not configured on Vercel environment variables." };
  }

  const existingTitlesArray: string[] = Array.isArray(existingTitles) ? existingTitles : [];
  const existingTitlesStr = existingTitlesArray.length > 0
    ? `\nCURRENTLY KNOWN POSITIONS ON BOARD: ${existingTitlesArray.slice(0, 10).join("; ")}. Ignore these exact titles if found.`
    : "";

  let targetUrl = (website || "").trim();
  if (targetUrl && !targetUrl.startsWith("http")) {
    targetUrl = `https://${targetUrl}`;
  }

  let liveWebText = "";

  // 1. Engine 1: Try Jina Reader fetch with browser user-agent headers
  if (targetUrl) {
    try {
      const jinaUrl = `[https://r.jina.ai/$](https://r.jina.ai/$){targetUrl}`;
      const jinaRes = await fetch(jinaUrl, {
        headers: {
          "Accept": "text/markdown",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "x-no-cache": "true"
        }
      });
      if (jinaRes.ok) {
        const rawText = await jinaRes.text();
        if (rawText && rawText.length > 200 && !rawText.includes("403 Forbidden") && !rawText.includes("Just a moment...")) {
          liveWebText = rawText.slice(0, 15000);
        }
      }
    } catch (e) {
      console.warn("[gemini-jobs] Jina fetch failed for target URL");
    }
  }

  // Extract from Engine 1
  let jobs: ScannedJob[] = [];
  if (liveWebText) {
    jobs = await extractJobsFromMarkdown(ai, employerName, targetUrl, liveWebText, existingTitlesStr);
  }

  // 2. Engine 2 Fallback: If direct scrape yielded 0 jobs, run Google Search Grounding
  if (jobs.length === 0) {
    jobs = await searchJobsViaGoogleGrounding(ai, employerName, targetUrl, existingTitlesStr);
    if (jobs.length > 0) {
      return { jobs, source: "google-search-grounding" };
    }
  }

  return {
    jobs,
    source: jobs.length > 0 ? "live-scrape" : "no-jobs-found",
    debug: { scrapedChars: liveWebText.length, targetUrl }
  };
}
