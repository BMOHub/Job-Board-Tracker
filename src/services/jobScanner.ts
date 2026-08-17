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

const getClientApiKey = () => {
  let key = "";
  try {
    if (typeof process !== "undefined" && (process as any).env) {
      key = (process as any).env.GEMINI_API_KEY;
    }
  } catch (e) {
    // Ignore error
  }

  if (!key || key === "MY_GEMINI_API_KEY") {
    try {
      key = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    } catch (e) {
      // Ignore error
    }
  }
  return key || "";
};

export const isGeminiConfigured = () => {
  const key = getClientApiKey();
  return !!key && key !== "MY_GEMINI_API_KEY" && key !== "MY_VITE_GEMINI_API_KEY";
};

let clientAiInstance: GoogleGenAI | null = null;
const getClientAI = () => {
  if (!clientAiInstance) {
    const key = getClientApiKey();
    if (key) {
      clientAiInstance = new GoogleGenAI({ apiKey: key });
    }
  }
  return clientAiInstance;
};

function sanitizeJobsArray(arr: any[]): ScannedJob[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && typeof item.title === "string")
    .map((item) => ({
      title: String(item.title || "").trim(),
      url: String(item.url || "").trim(),
      location: String(item.location || "Philadelphia, PA").trim(),
      city: String(item.city || "Philadelphia").trim(),
      roleType: String(item.roleType || "Full-time").trim(),
      postedDate: String(item.postedDate || "").trim(),
      description: String(item.description || "").trim(),
    }))
    .filter((item) => item.title.length > 0 && item.url.startsWith("http"));
}

export function parseAndCleanJobsJson(rawText: string): ScannedJob[] {
  if (!rawText || typeof rawText !== "string") return [];

  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // 1. Direct standard parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return sanitizeJobsArray(parsed);
    if (parsed && Array.isArray(parsed.jobs)) return sanitizeJobsArray(parsed.jobs);
  } catch (e) {}

  // 2. Extract array substring
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const arrayStr = text.substring(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed);
    } catch (e) {}

    // 3. Fix unescaped control characters and trailing commas
    try {
      const sanitized = arrayStr
        .replace(/[\x00-\x1F\x7F]/g, (char) => {
          if (char === "\t") return " ";
          if (char === "\n") return "\\n";
          if (char === "\r") return "";
          return "";
        })
        .replace(/,\s*([\]}])/g, "$1");
      const parsed = JSON.parse(sanitized);
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed);
    } catch (e) {}
  }

  // 4. Regex extraction of individual job objects
  const recoveredJobs: any[] = [];
  const objectRegex = /\{[\s\S]*?"title"[\s\S]*?"url"[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = objectRegex.exec(text)) !== null) {
    try {
      const objStr = match[0]
        .replace(/[\x00-\x1F\x7F]/g, (char) => (char === "\t" ? " " : char === "\n" ? "\\n" : ""))
        .replace(/,\s*([\]}])/g, "$1");
      const obj = JSON.parse(objStr);
      if (obj && obj.title && obj.url) {
        recoveredJobs.push(obj);
      }
    } catch (err) {
      try {
        const titleMatch = match[0].match(/"title"\s*:\s*"([^"]+)"/);
        const urlMatch = match[0].match(/"url"\s*:\s*"([^"]+)"/);
        const locationMatch = match[0].match(/"location"\s*:\s*"([^"]+)"/);
        const cityMatch = match[0].match(/"city"\s*:\s*"([^"]+)"/);
        const roleTypeMatch = match[0].match(/"roleType"\s*:\s*"([^"]+)"/);
        const postedDateMatch = match[0].match(/"postedDate"\s*:\s*"([^"]+)"/);
        const descriptionMatch = match[0].match(/"description"\s*:\s*"([^"]+)"/);
        if (titleMatch && urlMatch) {
          recoveredJobs.push({
            title: titleMatch[1],
            url: urlMatch[1],
            location: locationMatch ? locationMatch[1] : "Philadelphia, PA",
            city: cityMatch ? cityMatch[1] : "Philadelphia",
            roleType: roleTypeMatch ? roleTypeMatch[1] : "Full-time",
            postedDate: postedDateMatch ? postedDateMatch[1] : "",
            description: descriptionMatch ? descriptionMatch[1] : "",
          });
        }
      } catch (e) {}
    }
  }

  return sanitizeJobsArray(recoveredJobs);
}

// Direct client fallback if running in purely static environment (e.g. Vercel without Node server)
async function scanJobsDirectly(employerName: string, website: string): Promise<ScannedJob[]> {
  const ai = getClientAI();
  if (!ai) {
    throw new Error("Gemini API Key is not configured. Please set GEMINI_API_KEY or VITE_GEMINI_API_KEY.");
  }

  const prompt = `Find current job openings at ${employerName}.
  - LOCATION: Greater Philadelphia area (Philly, SE Pennsylvania, or South Jersey).
  - RECENCY: Focus on jobs posted in the last 2-3 weeks.
  - LINKS: You MUST provide the specific, direct URL to each individual job posting (e.g. Workday, Greenhouse, Lever, Taleo, or company career page). Avoid generic home pages.
  - WEBSITE FOR REFERENCE: ${website || "No official website provided"}
  
  Return a JSON array of up to 10 most recent jobs.
  Each object MUST have: title, url (direct link starting with http), location, city, roleType (Full-time, Part-time, Contract, or Internship), postedDate (YYYY-MM-DD), and a brief description.
  
  If you find no relevant jobs in the Philadelphia area, return an empty array [].`;

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.7-flash",
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: "The specific job title as listed on the posting" },
                url: { type: Type.STRING, description: "The DIRECT link to the specific job posting page" },
                location: { type: Type.STRING, description: "Full location string (e.g., 'Philadelphia, PA')" },
                city: { type: Type.STRING, description: "The specific city (e.g., 'Philadelphia', 'Camden', 'Norristown')" },
                roleType: { type: Type.STRING, description: "Employment type: 'Full-time', 'Part-time', 'Contract', 'Temporary', or 'Internship'" },
                postedDate: { type: Type.STRING, description: "The date the job was posted in YYYY-MM-DD format." },
                description: { type: Type.STRING, description: "A concise 1-2 sentence summary of the role's key responsibilities." }
              },
              required: ["title", "url", "location", "city", "roleType"]
            }
          }
        }
      });

      if (response && response.text) {
        return parseAndCleanJobsJson(response.text);
      }
      return [];
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      const isRateLimit = err?.status === 429 || 
        errorMsg.includes("429") || 
        errorMsg.includes("RESOURCE_EXHAUSTED") || 
        errorMsg.includes("quota") ||
        errorMsg.includes("rate-limits");

      if (isRateLimit && attempt < MAX_RETRIES) {
        const waitMs = (attempt + 1) * 8000 + Math.floor(Math.random() * 2000);
        console.warn(`[Client Gemini Pacing] Retrying in ${waitMs}ms due to rate limit 429...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw err;
    }
  }
  return [];
}

export async function scanJobsForEmployer(employerName: string, website: string): Promise<ScannedJob[]> {
  try {
    const response = await fetch("/api/scan-jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ employerName, website }),
    });

    if (response.ok) {
      const data = await response.json();
      return Array.isArray(data.jobs) ? sanitizeJobsArray(data.jobs) : [];
    }

    // If server route not found (404) or failed, try direct client fallback if key exists
    if (response.status === 404 && isGeminiConfigured()) {
      return await scanJobsDirectly(employerName, website);
    }

    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Scan failed for ${employerName}. Server returned status ${response.status}.`);
  } catch (error: any) {
    if (isGeminiConfigured() && (!error.message || !error.message.includes("429"))) {
      try {
        return await scanJobsDirectly(employerName, website);
      } catch (fallbackError: any) {
        throw fallbackError;
      }
    }
    throw error;
  }
}
