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
 * Resolves relative URLs (/get-involved/join-our-team) against the base website domain.
 */
function resolveJobUrl(rawUrl: string, baseUrl: string): string {
  let url = (rawUrl || "").trim();
  if (!url) return baseUrl;

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

/**
 * Finds sub-page links like "Careers", "Join Our Team", or "Jobs" in homepage markdown.
 */
function findCareerLinkInMarkdown(markdown: string, baseUrl: string): string | null {
  const linkRegex = /\[([^\]]*?(?:careers?|join\s+our\s+team|jobs?|work\s+with\s+us|employment|openings|positions)[^\]]*?)\]\((https?:\/\/[^\s\)]+|\/[^\s\)]+)\)/gi;
  const match = linkRegex.exec(markdown);
  if (match && match[2]) {
    return resolveJobUrl(match[2], baseUrl);
  }
  return null;
}

function sanitizeJobsArray(arr: any[], website = ""): ScannedJob[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && typeof item.title === "string")
    .map((item) => {
      const title = String(item.title || "").trim();
      const rawUrl = String(item.url || "").trim();
      const finalUrl = resolveJobUrl(rawUrl, website);
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

function parseAndCleanJobsJson(rawText: string, website = ""): ScannedJob[] {
  if (!rawText || typeof rawText !== "string") return [];
  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, website);
    if (parsed && Array.isArray(parsed.jobs)) return sanitizeJobsArray(parsed.jobs, website);
  } catch (e) {}

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const arrayStr = text.substring(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, website);
    } catch (e) {}
  }

  return [];
}

/**
 * Extracts real active jobs from scraped Markdown text using Gemini 2.0 Flash.
 */
async function extractJobsWithGemini(
  ai: GoogleGenAI,
  employerName: string,
  websiteUrl: string,
  markdownText: string,
  existingTitlesStr: string
): Promise<ScannedJob[]> {
  if (!markdownText || markdownText.length < 50) return [];

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
- "title": Exact Job Title (e.g. "Chief External Affairs Officer", "Global Smarts Program Mentor")
- "url": Application or detail link
- "location": Location (e.g., "Philadelphia, PA")
- "city": City name (e.g., "Philadelphia")
- "roleType": "Full-time", "Part-time", "Contract", or "Internship"
- "postedDate": Date posted (YYYY-MM-DD) or current date
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
    console.error("[gemini-jobs extraction error]:", error);
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
    ? `\nCURRENTLY KNOWN POSITIONS ON BOARD: ${existingTitlesArray.slice(0, 10).join("; ")}. Ignore these exact titles.`
    : "";

  let targetUrl = (website || "").trim();
  if (targetUrl && !targetUrl.startsWith("http")) {
    targetUrl = `https://${targetUrl}`;
  }

  let liveWebText = "";

  // 1. Fetch live page markdown via Jina Reader (unencoded target URL format)
  if (targetUrl) {
    try {
      const jinaUrl = `[https://r.jina.ai/$](https://r.jina.ai/$){targetUrl}`;
      const jinaRes = await fetch(jinaUrl, { headers: { "Accept": "text/markdown" } });
      if (jinaRes.ok) {
        const rawText = await jinaRes.text();
        liveWebText = rawText.slice(0, 15000);
      }
    } catch (e) {
      console.warn("[gemini-jobs] Jina fetch failed for target URL");
    }
  }

  // 2. Extract jobs from initial page content
  let jobs = await extractJobsWithGemini(ai, employerName, targetUrl, liveWebText, existingTitlesStr);

  // 3. If no jobs found on main page, search for a "Careers" or "Join Our Team" link and follow it
  if (jobs.length === 0 && liveWebText) {
    const careerSubUrl = findCareerLinkInMarkdown(liveWebText, targetUrl);
    if (careerSubUrl && careerSubUrl !== targetUrl) {
      try {
        const jinaSubUrl = `[https://r.jina.ai/$](https://r.jina.ai/$){careerSubUrl}`;
        const jinaSubRes = await fetch(jinaSubUrl, { headers: { "Accept": "text/markdown" } });
        if (jinaSubRes.ok) {
          const subPageText = (await jinaSubRes.text()).slice(0, 15000);
          jobs = await extractJobsWithGemini(ai, employerName, careerSubUrl, subPageText, existingTitlesStr);
        }
      } catch (e) {
        console.warn("[gemini-jobs] Jina fetch failed for sub-career URL");
      }
    }
  }

  return { jobs, source: jobs.length > 0 ? "live-scrape" : "no-jobs-found" };
}
