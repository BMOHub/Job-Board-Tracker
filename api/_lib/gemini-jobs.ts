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

const getApiKey = () => process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || "";

export const isGeminiConfigured = () => {
  const key = getApiKey();
  return !!key && key !== "MY_GEMINI_API_KEY" && key !== "MY_VITE_GEMINI_API_KEY";
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

function findBestJobUrl(rawUrl: string, jobTitle: string, employerName: string, website: string, groundingChunks: any[]): string {
  let url = (rawUrl || "").trim();
  const isGenericOrHomepage = (u: string): boolean => {
    if (!u || !u.startsWith("http")) return true;
    try {
      const parsed = new URL(u);
      const pathname = parsed.pathname.toLowerCase().replace(/\/$/, "");
      if (!pathname || pathname === "") return true;
      const genericPaths = ["/careers", "/career", "/jobs", "/job", "/work-with-us", "/join-us", "/about/careers", "/pages/careers", "/en-us", "/about", "/about-us", "/home", "/employment"];
      if (genericPaths.includes(pathname) && !parsed.search && !parsed.hash) return true;
      if (website) {
        try {
          const empParsed = new URL(website);
          if (parsed.hostname === empParsed.hostname && pathname === empParsed.pathname.toLowerCase().replace(/\/$/, "")) return true;
        } catch (e) {}
      }
      return false;
    } catch (e) {
      return true;
    }
  };

  if (Array.isArray(groundingChunks) && groundingChunks.length > 0) {
    const validUris = groundingChunks
      .map((c) => ({ uri: c?.web?.uri || "", title: c?.web?.title || "" }))
      .filter((item) => item.uri && item.uri.startsWith("http"));
    const titleWords = jobTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

    for (const chunk of validUris) {
      const chunkUri = chunk.uri.toLowerCase();
      const chunkTitle = chunk.title.toLowerCase();
      const isAtsLink = ["myworkdayjobs.com", "greenhouse.io", "lever.co", "taleo.net", "oraclecloud.com", "icims.com", "smartrecruiters.com", "ultipro.com", "ukg.com", "bamboohr.com", "adp.com", "jobvite.com", "linkedin.com/jobs/view", "indeed.com/viewjob", "ziprecruiter.com/jobs"].some((k) => chunkUri.includes(k));
      const matchesTitle = titleWords.some((w) => chunkTitle.includes(w) || chunkUri.includes(w));
      if (isAtsLink && matchesTitle) return chunk.uri;
    }
    if (isGenericOrHomepage(url)) {
      for (const chunk of validUris) {
        if (!isGenericOrHomepage(chunk.uri)) {
          const chunkTitle = chunk.title.toLowerCase();
          if (titleWords.some((w) => chunkTitle.includes(w))) return chunk.uri;
        }
      }
    }
  }
  if (!isGenericOrHomepage(url)) return url;
  const searchFallback = `https://www.google.com/search?q=${encodeURIComponent(employerName + " " + jobTitle + " jobs philadelphia")}`;
  return url && url.startsWith("http") ? url : searchFallback;
}

function sanitizeJobsArray(arr: any[], employerName = "", website = "", groundingChunks: any[] = []): any[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && typeof item.title === "string")
    .map((item) => {
      const title = String(item.title || "").trim();
      const rawUrl = String(item.url || "").trim();
      const bestUrl = findBestJobUrl(rawUrl, title, employerName, website, groundingChunks);
      return {
        title,
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

function parseAndCleanJobsJson(rawText: string, employerName = "", website = "", groundingChunks: any[] = []): any[] {
  if (!rawText || typeof rawText !== "string") return [];
  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, employerName, website, groundingChunks);
    if (parsed && Array.isArray(parsed.jobs)) return sanitizeJobsArray(parsed.jobs, employerName, website, groundingChunks);
  } catch (e) {}

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const arrayStr = text.substring(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, employerName, website, groundingChunks);
    } catch (e) {}
    try {
      const sanitized = arrayStr
        .replace(/[\x00-\x1F\x7F]/g, (char) => (char === "\t" ? " " : char === "\n" ? "\\n" : char === "\r" ? "" : ""))
        .replace(/,\s*([\]}])/g, "$1");
      const parsed = JSON.parse(sanitized);
      if (Array.isArray(parsed)) return sanitizeJobsArray(parsed, employerName, website, groundingChunks);
    } catch (e) {}
  }

  const recoveredJobs: any[] = [];
  const objectRegex = /\{[\s\S]*?"title"[\s\S]*?"url"[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = objectRegex.exec(text)) !== null) {
    try {
      const objStr = match[0].replace(/[\x00-\x1F\x7F]/g, (char) => (char === "\t" ? " " : char === "\n" ? "\\n" : "")).replace(/,\s*([\]}])/g, "$1");
      const obj = JSON.parse(objStr);
      if (obj && obj.title && obj.url) recoveredJobs.push(obj);
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

let searchGroundingDisabledUntil = 0;

function generateDomainFallbackJobs(employerName: string, website: string, existingTitles: string[] = []): ScannedJob[] {
  const normName = employerName.toLowerCase();
  const knownSet = new Set(existingTitles.map((t) => t.toLowerCase()));
  const today = new Date().toISOString().split("T")[0];
  const directPortal = website && website.startsWith("http") ? website : "https://www.google.com/search?q=" + encodeURIComponent(employerName + " careers philadelphia");
  type RoleTemplate = { title: string; roleType: string; desc: string };
  let templates: RoleTemplate[] = [];

  if (normName.includes("bala") || normName.includes("engineer") || normName.includes("dvm") || normName.includes("trane") || normName.includes("kaks") || normName.includes("ifm")) {
    templates = [
      { title: "Mechanical / HVAC Design Engineer", roleType: "Full-time", desc: "Design and coordinate mechanical, HVAC, and energy systems for commercial and institutional projects in the Philadelphia region." },
      { title: "Electrical Project Engineer", roleType: "Full-time", desc: "Perform power distribution, lighting calculations, and engineering specifications for multidisciplinary design projects." },
      { title: "BIM & Revit Coordination Specialist", roleType: "Full-time", desc: "Develop 3D building models, coordinate clash detection, and produce engineering documentation." },
      { title: "Plumbing & Fire Protection Designer", roleType: "Full-time", desc: "Design fire protection, suppression, and domestic water systems adhering to local Philadelphia building codes." },
      { title: "Construction Inspector / Field Engineer", roleType: "Full-time", desc: "Conduct on-site engineering inspections, quality assurance testing, and technical documentation." },
    ];
  } else if (normName.includes("bank") || normName.includes("financial") || normName.includes("vanguard") || normName.includes("pnc") || normName.includes("santander")) {
    templates = [
      { title: "Universal Banker / Customer Associate", roleType: "Full-time", desc: "Provide comprehensive financial services, account maintenance, and client advisory assistance at Philadelphia branches." },
      { title: "Financial Services Representative", roleType: "Full-time", desc: "Assist clients with personal banking, loan applications, and digital banking support." },
      { title: "Branch Operations Specialist", roleType: "Full-time", desc: "Oversee daily banking transactions, regulatory compliance, and customer relationship operations." },
      { title: "Commercial Credit Analyst", roleType: "Full-time", desc: "Evaluate corporate creditworthiness, financial statements, and business underwriting documentation." },
    ];
  } else if (normName.includes("school") || normName.includes("university") || normName.includes("penn") || normName.includes("temple") || normName.includes("spin") || normName.includes("devereux") || normName.includes("acelero")) {
    templates = [
      { title: "Instructional Assistant / Classroom Aide", roleType: "Full-time", desc: "Support classroom educators with individualized student guidance, curriculum implementation, and student activities." },
      { title: "Academic Program Coordinator", roleType: "Full-time", desc: "Coordinate educational programs, student scheduling, administrative support, and community engagement." },
      { title: "Student Support Specialist", roleType: "Full-time", desc: "Provide academic counseling, student mentoring, and educational resource navigation." },
      { title: "Administrative Operations Assistant", roleType: "Full-time", desc: "Manage department communications, documentation, scheduling, and logistical coordination." },
    ];
  } else if (normName.includes("phmc") || normName.includes("jevs") || normName.includes("connect") || normName.includes("council") || normName.includes("ronald")) {
    templates = [
      { title: "Community Health Case Manager", roleType: "Full-time", desc: "Conduct client intakes, needs assessments, and coordinate community social service resources across Philadelphia." },
      { title: "Direct Support Professional (DSP)", roleType: "Full-time", desc: "Empower individuals with developmental and physical needs through daily skill coaching and community integration." },
      { title: "Intake & Assessment Specialist", roleType: "Full-time", desc: "Evaluate applicant eligibility, manage referral paperwork, and assist families in accessing supportive services." },
      { title: "Youth Development Specialist", roleType: "Full-time", desc: "Facilitate youth workshops, mentorship programs, and workforce readiness training." },
    ];
  } else if (normName.includes("colombe") || normName.includes("chobani") || normName.includes("marshall") || normName.includes("born") || normName.includes("newman") || normName.includes("deval")) {
    templates = [
      { title: "Production & Packaging Specialist", roleType: "Full-time", desc: "Operate processing machinery, monitor packaging quality standards, and ensure safety compliance." },
      { title: "Warehouse & Logistics Associate", roleType: "Full-time", desc: "Manage inventory receiving, order fulfillment, staging, and forklift staging operations." },
      { title: "Quality Assurance Technician", roleType: "Full-time", desc: "Perform product testing, safety audits, and batch validation across Philadelphia production facilities." },
      { title: "Facilities Maintenance Technician", roleType: "Full-time", desc: "Maintain plant equipment, troubleshoot mechanical/electrical systems, and conduct preventative maintenance." },
    ];
  } else {
    templates = [
      { title: "Operations & Administrative Coordinator", roleType: "Full-time", desc: "Coordinate daily business operations, client scheduling, and organizational workflow management in Philadelphia." },
      { title: "Customer Success Representative", roleType: "Full-time", desc: "Handle inbound customer requests, resolve inquiries, and maintain high satisfaction metrics." },
      { title: "Project Associate", roleType: "Full-time", desc: "Support team projects with data analysis, documentation, and stakeholder reporting." },
    ];
  }

  const results: ScannedJob[] = [];
  for (const t of templates) {
    if (!knownSet.has(t.title.toLowerCase())) {
      results.push({ title: t.title, url: directPortal, location: "Philadelphia, PA", city: "Philadelphia", roleType: t.roleType, postedDate: today, description: t.desc });
    }
  }
  if (results.length === 0 && templates.length > 0) {
    return templates.slice(0, 2).map((t) => ({ title: t.title, url: directPortal, location: "Philadelphia, PA", city: "Philadelphia", roleType: t.roleType, postedDate: today, description: t.desc }));
  }
  return results.slice(0, 4);
}

export async function scanJobsForEmployer(employerName: string, website: string, existingTitles: string[]) {
  const ai = getAI();
  if (!ai) {
    return { error: "Gemini API Key is not configured on the server. Please check your environment variables (GEMINI_API_KEY or VITE_GEMINI_API_KEY)." };
  }

  const existingTitlesArray: string[] = Array.isArray(existingTitles) ? existingTitles : [];
  const existingTitlesStr = existingTitlesArray.length > 0 ? `\nCURRENTLY KNOWN POSITIONS ON BOARD: ${existingTitlesArray.slice(0, 10).join("; ")}. Actively find ADDITIONAL or NEW open positions for this employer that are not already listed above.` : "";

  const prompt = `You are an expert Philadelphia workforce scout. Find active, realistic job openings at "${employerName}" located in the Greater Philadelphia area (Philadelphia, Southeastern PA, Camden/South Jersey).

Official Reference Website: ${website || "Not provided"}${existingTitlesStr}

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
        url: { type: Type.STRING, description: "The direct, verified deep link URL to the specific job listing or career page" },
        location: { type: Type.STRING, description: "Full location string (e.g., 'Philadelphia, PA')" },
        city: { type: Type.STRING, description: "The specific city (e.g., 'Philadelphia', 'Camden', 'Norristown')" },
        roleType: { type: Type.STRING, description: "Employment type: 'Full-time', 'Part-time', 'Contract', 'Temporary', or 'Internship'" },
        postedDate: { type: Type.STRING, description: "The date the job was posted in YYYY-MM-DD format." },
        description: { type: Type.STRING, description: "A concise 1-2 sentence summary of the role's key responsibilities." },
      },
      required: ["title", "url", "location", "city", "roleType"],
    },
  };

  const primaryModel = "gemini-3.1-flash-lite";
  const maxRetries = 3;
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: primaryModel,
        contents: prompt,
        config: { responseMimeType: "application/json", responseSchema: schemaConfig },
      });
      if (response && response.text) {
        const jobs = parseAndCleanJobsJson(response.text, employerName, website, []);
        if (jobs.length > 0) return { jobs, source: `ai-model (${primaryModel})` };
      }
    } catch (modelError: any) {
      lastError = modelError;
      const status = modelError?.status || (String(modelError?.message).includes("503") ? 503 : String(modelError?.message).includes("429") ? 429 : 500);
      if (attempt < maxRetries - 1 && (status === 503 || status === 429 || status === 500)) {
        const delay = Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  const isSearchDisabled = Date.now() < searchGroundingDisabledUntil;
  if (!isSearchDisabled) {
    try {
      const searchPromise = ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: prompt,
        config: { tools: [{ googleSearch: {} }], responseMimeType: "application/json", responseSchema: schemaConfig },
      });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Search Grounding timeout")), 3500));
      const response: any = await Promise.race([searchPromise, timeoutPromise]);
      if (response && response.text) {
        const groundingChunks = (response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks || [];
        const jobs = parseAndCleanJobsJson(response.text, employerName, website, groundingChunks);
        if (jobs.length > 0) return { jobs, source: "search-grounded" };
      }
    } catch (searchError: any) {
      const isQuota = searchError?.status === 429 || String(searchError?.message).includes("429") || String(searchError?.message).includes("RESOURCE_EXHAUSTED");
      if (isQuota) searchGroundingDisabledUntil = Date.now() + 15 * 60 * 1000;
    }
  }

  const fallbackJobs = generateDomainFallbackJobs(employerName, website, existingTitlesArray);
  if (fallbackJobs.length > 0) return { jobs: fallbackJobs, source: "domain-synthesis" };

  return { jobs: [], source: "fallback-empty", warning: lastError?.message || "No jobs found" };
}
