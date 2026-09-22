import { GoogleGenAI } from "@google/genai";

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
 * Resolves relative URLs and attempts to match with Google Search Grounding URIs if available.
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

  // Resolve relative links (e.g. "/join-our-team")
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
    text = text.replace(/^
