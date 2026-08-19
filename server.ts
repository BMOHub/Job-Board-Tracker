import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dns from "dns";

// Fix Node localhost performance issues
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = 3000;

app.use(express.json());

const getApiKey = () => {
  return process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || "";
};

const isGeminiConfigured = () => {
  const key = getApiKey();
  return !!key && key !== "MY_GEMINI_API_KEY" && key !== "MY_VITE_GEMINI_API_KEY";
};

// Initialize GoogleGenAI client lazily to avoid throwing errors on boot if key is temporarily missing
let aiInstance: GoogleGenAI | null = null;
const getAI = () => {
  if (!aiInstance) {
    const key = getApiKey();
    if (key) {
      aiInstance = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    }
  }
  return aiInstance;
};

// Robust URL validator and enhancer using Google Search grounding metadata
function findBestJobUrl(
  rawUrl: string, 
  jobTitle: string, 
  employerName: string, 
  website: string, 
  groundingChunks: any[]
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

    // Check if any grounding chunk URI contains known ATS keywords or job-specific paths
    const titleWords = jobTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    // First, look for a grounding chunk that mentions title words and is not generic
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

// Robust JSON parser that handles markdown fences, unescaped control characters, tabs, newlines, and truncated chunks
function sanitizeJobsArray(
  arr: any[], 
  employerName = "", 
  website = "", 
  groundingChunks: any[] = []
): any[] {
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

function parseAndCleanJobsJson(
  rawText: string, 
  employerName = "", 
  website = "", 
  groundingChunks: any[] = []
): any[] {
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
  } catch (e) {
    // Continue to repair
  }

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

  // 4. Regex extraction of individual job objects (resilient to broken or truncated JSON streams)
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

// API Endpoint: Get Gemini Status
app.get("/api/gemini-status", (req, res) => {
  res.json({ configured: isGeminiConfigured() });
});

// API Endpoint: Scan Jobs for Employer
app.post("/api/scan-jobs", async (req, res) => {
  const { employerName, website } = req.body;

  if (!employerName) {
    return res.status(400).json({ error: "Employer Name is required." });
  }

  const ai = getAI();
  if (!ai) {
    return res.status(400).json({
      error: "Gemini API Key is not configured on the server. Please check your environment variables (GEMINI_API_KEY or VITE_GEMINI_API_KEY).",
    });
  }

  const prompt = `Find current job openings at "${employerName}" located in the Greater Philadelphia area (Philadelphia, SE Pennsylvania, Camden/South Jersey).
  Official Reference Website: ${website || "Not provided"}

  CRITICAL DEEP-LINK REQUIREMENTS:
  - You MUST provide the exact, direct URL to each specific job posting (e.g. on Workday, Greenhouse, Lever, Taleo, iCIMS, SmartRecruiters, UKG, BambooHR, ADP, LinkedIn Jobs, or the company's direct job requisition page).
  - DO NOT return generic root homepages (e.g. "https://example.com" or "https://example.com/careers") if a specific job requisition link exists.
  - DO NOT hallucinate or guess fake job URLs. Use only real, verified URLs found in search results.
  - Prioritize recent openings (posted within the last 2-4 weeks).

  Return a JSON array of up to 10 openings.
  Each object MUST contain:
  - "title": Job title (e.g., "Case Manager", "Forklift Operator", "Teller", "Instructional Assistant")
  - "url": The exact, direct deep-link URL to this specific job listing (must start with https:// or http://)
  - "location": Location (e.g., "Philadelphia, PA", "Camden, NJ")
  - "city": City name
  - "roleType": "Full-time", "Part-time", "Contract", or "Internship"
  - "postedDate": Date posted (YYYY-MM-DD) if available, otherwise empty string
  - "description": 1-2 sentence description of key duties.

  If no active Philadelphia-area jobs are found, return an empty array [].`;

  const MAX_RETRIES = 3;
  let lastError: any = null;

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
                url: { type: Type.STRING, description: "The direct, verified deep link URL to the specific job listing" },
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
        const groundingChunks = (response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks || [];
        const jobs = parseAndCleanJobsJson(response.text, employerName, website, groundingChunks);
        return res.json({ jobs });
      }

      console.warn(`No response text from Gemini for ${employerName}`);
      return res.json({ jobs: [] });
    } catch (error: any) {
      lastError = error;
      const errorMsg = error?.message || String(error);
      const isRateLimit = error?.status === 429 || 
        errorMsg.includes("429") || 
        errorMsg.includes("RESOURCE_EXHAUSTED") || 
        errorMsg.includes("quota") ||
        errorMsg.includes("rate-limits");

      if (isRateLimit && attempt < MAX_RETRIES) {
        const waitMs = (attempt + 1) * 8000 + Math.floor(Math.random() * 2000);
        console.warn(`[Gemini Free Tier Pacing] Rate limit 429 encountered for ${employerName}. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      console.error(`Error scanning jobs for ${employerName}:`, error);
      if (isRateLimit) {
        return res.status(429).json({ 
          error: `Free tier rate limit reached for ${employerName}. Please wait 15-30 seconds before scanning more employers.`,
          isRateLimit: true 
        });
      }
      return res.status(500).json({ error: error.message || "An error occurred during Gemini scanning." });
    }
  }
});

// Vite middleware flow setup
async function setupVite() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

setupVite().catch((err) => {
  console.error("Failed to start Vite dev server wrapper:", err);
});
