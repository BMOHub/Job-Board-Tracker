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

// Robust URL validator and enhancer using Google Search grounding metadata
function findBestJobUrl(
  rawUrl: string, 
  jobTitle: string, 
  employerName: string, 
  website: string, 
  groundingChunks: any[] = []
): string {
  let url = (rawUrl || "").trim();

  // Helper to check if URL is generic or top-level homepage/careers root
  const isGenericOrHomepage = (u: string): boolean => {
    if (!u || !u.startsWith("http")) return true;
    try {
      const parsed = new URL(u);
      const pathname = parsed.pathname.toLowerCase().replace(/\/$/, "");
      
      // Bare domain (e.g., https://example.com or https://example.com/)
      if (!pathname || pathname === "") return true;

      // Generic single-segment career root pages without specific job IDs
      const genericPaths = [
        "/careers", "/career", "/jobs", "/job", "/work-with-us", 
        "/join-us", "/about/careers", "/pages/careers", "/en-us",
        "/about", "/about-us", "/home", "/employment"
      ];
      if (genericPaths.includes(pathname) && !parsed.search && !parsed.hash) {
        return true;
      }

      // Matches employer's generic website exactly
      if (website) {
        try {
          const empParsed = new URL(website);
          if (parsed.hostname === empParsed.hostname && (pathname === empParsed.pathname.toLowerCase().replace(/\/$/, ""))) {
            return true;
          }
        } catch (e) {}
      }

      return false;
    } catch (e) {
      return true;
    }
  };

  // 1. If we have grounding chunks from Google Search, try to find a verified deep link matching the job
  if (Array.isArray(groundingChunks) && groundingChunks.length > 0) {
    const validUris = groundingChunks
      .map(c => ({
        uri: c?.web?.uri || "",
        title: c?.web?.title || ""
      }))
      .filter(item => item.uri && item.uri.startsWith("http"));

    const titleWords = jobTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    // First, look for a grounding chunk that mentions title words and is an ATS deep link
    for (const chunk of validUris) {
      const chunkUri = chunk.uri.toLowerCase();
      const chunkTitle = chunk.title.toLowerCase();

      const isAtsLink = chunkUri.includes("myworkdayjobs.com") ||
                        chunkUri.includes("greenhouse.io") ||
                        chunkUri.includes("lever.co") ||
                        chunkUri.includes("taleo.net") ||
                        chunkUri.includes("oraclecloud.com") ||
                        chunkUri.includes("icims.com") ||
                        chunkUri.includes("smartrecruiters.com") ||
                        chunkUri.includes("ultipro.com") ||
                        chunkUri.includes("ukg.com") ||
                        chunkUri.includes("bamboohr.com") ||
                        chunkUri.includes("adp.com") ||
                        chunkUri.includes("jobvite.com") ||
                        chunkUri.includes("linkedin.com/jobs/view") ||
                        chunkUri.includes("indeed.com/viewjob") ||
                        chunkUri.includes("ziprecruiter.com/jobs");

      const matchesTitle = titleWords.some(w => chunkTitle.includes(w) || chunkUri.includes(w));
      
      if (isAtsLink && matchesTitle) {
        return chunk.uri;
      }
    }

    // If the original URL is generic, pick the best non-generic grounding URI
    if (isGenericOrHomepage(url)) {
      for (const chunk of validUris) {
        if (!isGenericOrHomepage(chunk.uri)) {
          const chunkTitle = chunk.title.toLowerCase();
          const matchesTitle = titleWords.some(w => chunkTitle.includes(w));
          if (matchesTitle) {
            return chunk.uri;
          }
        }
      }
    }
  }

  // 2. If the URL is valid and non-generic, return it
  if (!isGenericOrHomepage(url)) {
    return url;
  }

  // 3. If the URL is STILL generic, fall back to a precision targeted query link so users never get a broken 404
  const searchFallback = `https://www.google.com/search?q=${encodeURIComponent(employerName + ' ' + jobTitle + ' jobs philadelphia')}`;
  return url && url.startsWith("http") ? url : searchFallback;
}

function sanitizeJobsArray(
  arr: any[], 
  employerName = "", 
  website = "", 
  groundingChunks: any[] = []
): ScannedJob[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && typeof item.title === "string")
    .map((item) => {
      const title = String(item.title || "").trim();
      const rawUrl = String(item.url || "").trim();
      const bestUrl = findBestJobUrl(rawUrl, title, employerName, website, groundingChunks);

      return {
        title: title,
        url: bestUrl,
        location: String(item.location || "Philadelphia, PA").trim(),
        city: String(item.city || "Philadelphia").trim(),
        roleType: String(item.roleType || "Full-time").trim(),
        postedDate: String(item.postedDate || "").trim(),
        description: String(item.description || "").trim(),
      };
    })
    .filter((item) => item.title.length > 0 && item.url.startsWith("http"));
}

export function parseAndCleanJobsJson(
  rawText: string, 
  employerName = "", 
  website = "", 
  groundingChunks: any[] = []
): ScannedJob[] {
  if (!rawText || typeof rawText !== "string") return [];

  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // 1. Direct standard parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, employerName, website, groundingChunks);
    if (parsed && Array.isArray(parsed.jobs)) return sanitizeJobsArray(parsed.jobs, employerName, website, groundingChunks);
  } catch (e) {}

  // 2. Extract array substring
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const arrayStr = text.substring(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, employerName, website, groundingChunks);
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
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, employerName, website, groundingChunks);
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

  return sanitizeJobsArray(recoveredJobs, employerName, website, groundingChunks);
}

// Direct client fallback if running in purely static environment (e.g. Vercel without Node server)
async function scanJobsDirectly(employerName: string, website: string): Promise<ScannedJob[]> {
  const ai = getClientAI();
  if (!ai) {
    throw new Error("Gemini API Key is not configured. Please set GEMINI_API_KEY or VITE_GEMINI_API_KEY.");
  }

  const prompt = `You are an expert Philadelphia workforce scout. Find active, realistic job openings at "${employerName}" located in the Greater Philadelphia area (Philadelphia, Southeastern PA, Camden/South Jersey).
Official Reference Website: ${website || "Not provided"}

CRITICAL DEEP-LINK REQUIREMENTS:
- Provide the direct career portal or job application URL starting with https:// or http:// (e.g. on Workday, Greenhouse, Lever, Taleo, iCIMS, SmartRecruiters, UKG, BambooHR, ADP, LinkedIn Jobs, or the employer's official career portal: ${website || "careers portal"}).
- Return realistic active job roles suitable for Philadelphia workforce jobseekers.

Return a JSON array of 3 to 8 openings.
Each object MUST contain:
- "title": Job title (e.g., "Direct Support Professional", "Case Manager", "Administrative Assistant", "Forklift Operator", "Teller", "Instructional Aide")
- "url": The exact or direct careers URL to apply or view this job
- "location": Location (e.g., "Philadelphia, PA", "Camden, NJ", "Norristown, PA")
- "city": City name (e.g., "Philadelphia")
- "roleType": "Full-time", "Part-time", "Contract", or "Internship"
- "postedDate": Date posted (YYYY-MM-DD) or recent date
- "description": 1-2 sentence description of key duties and qualifications.

If no jobs exist, return an empty array [].`;

  const schemaConfig = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "The specific job title as listed on the posting" },
        url: { type: Type.STRING, description: "The direct, verified deep link URL to the specific job listing" },
        location: { type: Type.STRING, description: "Full location string (e.g., 'Philadelphia, PA')" },
        city: { type: Type.STRING, description: "The specific city (e.g., 'Philadelphia', 'Camden', 'Norristown')" },
        roleType: { type: Type.STRING, description: "Employment type: 'Full-time', 'Part-time', 'Contract', 'Temporary', or 'Internship'" },
        postedDate: { type: Type.STRING, description: "The date the job was posted in YYYY-MM-DD format." },
        description: { type: Type.STRING, description: "A concise 1-2 sentence summary of the role's key responsibilities." }
      },
      required: ["title", "url", "location", "city", "roleType"]
    }
  };

  // Attempt 1: Search Grounding
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.7-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: schemaConfig
      }
    });

    if (response && response.text) {
      const groundingChunks = (response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks || [];
      const jobs = parseAndCleanJobsJson(response.text, employerName, website, groundingChunks);
      if (jobs.length > 0) return jobs;
    }
  } catch (searchErr) {
    console.warn(`[Client Scanner] Search Grounding skipped for ${employerName}. Using Direct AI Model fallback...`);
  }

  // Attempt 2: Direct model fallback without search tool
  const candidateModels = ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
  let lastErr: any = null;

  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: schemaConfig
        }
      });

      if (response && response.text) {
        return parseAndCleanJobsJson(response.text, employerName, website, []);
      }
    } catch (err: any) {
      lastErr = err;
      console.warn(`[Client Cascade] Model ${modelName} encountered error for ${employerName}:`, err?.status || err?.message);
      await new Promise(r => setTimeout(r, 400));
    }
  }

  if (lastErr) throw lastErr;
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
