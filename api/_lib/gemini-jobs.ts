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

export interface ScanJobsResult {
  jobs: ScannedJob[];
  source: "official-page" | "grounded-pages" | "no-jobs-found";
  authoritative: boolean;
  warning?: string;
  error?: string;
}

export interface SourceDocument {
  url: string;
  text: string;
}

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const MAX_DOCUMENT_CHARS = 80_000;
const READER_TIMEOUT_MS = 12_000;

export function hasGeminiApiKey(): boolean {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || "";
  return Boolean(key && key !== "MY_GEMINI_API_KEY" && key !== "MY_VITE_GEMINI_API_KEY");
}

function getAIClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || "";
  if (!hasGeminiApiKey()) return null;

  try {
    return new GoogleGenAI({ apiKey: key });
  } catch (error) {
    console.error("Failed to initialize GoogleGenAI:", error);
    return null;
  }
}

function normalizeHttpUrl(value: unknown, baseUrl?: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function comparableUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.href;
  } catch {
    return value;
  }
}

function normalizeEvidence(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDocumentUrls(document: SourceDocument): Set<string> {
  const urls = new Set<string>([comparableUrl(document.url)]);
  const candidates = document.text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];

  for (const candidate of candidates) {
    const normalized = normalizeHttpUrl(candidate.replace(/[.,;:!?]+$/, ""));
    if (normalized) urls.add(comparableUrl(normalized));
  }

  for (const match of document.text.matchAll(/\]\(([^)]+)\)/g)) {
    const normalized = normalizeHttpUrl(match[1], document.url);
    if (normalized) urls.add(comparableUrl(normalized));
  }

  return urls;
}

function containsClosedEvidence(documentText: string, title: string): boolean {
  const needle = normalizeEvidence(title);
  const closedPhrases = [
    "no longer accepting applications",
    "no longer available",
    "position has been filled",
    "posting has expired",
    "job has expired",
    "applications are closed",
  ];
  const lines = documentText.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    if (!normalizeEvidence(lines[index]).includes(needle)) continue;
    const block = [lines[index]];
    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset += 1) {
      if (!lines[index + offset].trim()) break;
      block.push(lines[index + offset]);
    }
    const nearby = normalizeEvidence(block.join(" "));
    if (closedPhrases.some((phrase) => nearby.includes(phrase))) return true;
  }

  return false;
}

function parseJsonArray(rawText: string): unknown[] {
  if (!rawText) return [];
  const text = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  const attempts = [text];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).jobs)) {
        return (parsed as any).jobs;
      }
    } catch {
      // Invalid model output is not evidence. Try the next bounded representation.
    }
  }

  return [];
}

/**
 * Converts model output to jobs only when the title and URL are present in a
 * fetched source document. This is the final guard against plausible but
 * invented model output.
 */
export function parseEvidenceBackedJobs(rawText: string, documents: SourceDocument[]): ScannedJob[] {
  const documentIndex = new Map(
    documents.map((document) => [comparableUrl(document.url), {
      ...document,
      normalizedText: normalizeEvidence(document.text),
      urls: extractDocumentUrls(document),
    }]),
  );
  const deduplicated = new Map<string, ScannedJob>();

  for (const item of parseJsonArray(rawText)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const title = String(candidate.title || "").trim();
    const sourceUrl = normalizeHttpUrl(candidate.sourceUrl);
    if (!title || !sourceUrl) continue;

    const source = documentIndex.get(comparableUrl(sourceUrl));
    if (!source || !source.normalizedText.includes(normalizeEvidence(title))) continue;
    if (containsClosedEvidence(source.text, title)) continue;

    const jobUrl = normalizeHttpUrl(candidate.url, source.url) || source.url;
    if (!source.urls.has(comparableUrl(jobUrl))) continue;

    const location = String(candidate.location || "").trim();
    const job: ScannedJob = {
      title,
      url: jobUrl,
      location,
      city: String(candidate.city || "").trim(),
      roleType: String(candidate.roleType || "Not specified").trim(),
      postedDate: String(candidate.postedDate || "").trim(),
      description: String(candidate.description || "").trim(),
    };
    const key = `${normalizeEvidence(title)}|${normalizeEvidence(location)}`;
    if (!deduplicated.has(key)) deduplicated.set(key, job);
  }

  return [...deduplicated.values()];
}

async function fetchReadablePage(url: string): Promise<SourceDocument | null> {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return null;

  try {
    const response = await fetch(`https://r.jina.ai/${normalized}`, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const text = (await response.text()).trim();
    if (
      text.length < 120 ||
      /403 forbidden|just a moment|access denied|captcha/i.test(text.slice(0, 2_000))
    ) {
      return null;
    }

    return { url: normalized, text };
  } catch (error) {
    console.warn(`[Job scanner] Could not read ${normalized}:`, error);
    return null;
  }
}

function buildExtractionPrompt(employerName: string, documents: SourceDocument[]): string {
  let remaining = MAX_DOCUMENT_CHARS;
  const sources = documents.map((document, index) => {
    const text = document.text.slice(0, remaining);
    remaining = Math.max(0, remaining - text.length);
    return `SOURCE ${index + 1}\nSOURCE_URL: ${document.url}\n${text}`;
  }).filter((source) => source.length > 0).join("\n\n---\n\n");

  return `Extract currently open jobs for "${employerName}" in Greater Philadelphia from the supplied sources.

Evidence rules:
- Return only positions explicitly shown as open in a source. Never infer or invent a role.
- Exclude expired, filled, closed, archived, generic talent-network, and search-category entries.
- Prefer the direct job-detail/application URL shown in that same source. If the source itself is the detail page, use SOURCE_URL.
- Copy the exact job title. Do not rewrite it.
- Include only Philadelphia, Southeastern Pennsylvania, or Camden/South Jersey roles. Include remote roles only when the source says applicants in this region are eligible.
- Copy dates, locations, employment types, and descriptions only when stated; otherwise use an empty string.
- sourceUrl must exactly equal the SOURCE_URL containing the evidence.
- An empty array is correct when there is not enough evidence.

Return only a JSON array with title, url, sourceUrl, location, city, roleType, postedDate, and description.

${sources}`;
}

const extractionSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      url: { type: Type.STRING },
      sourceUrl: { type: Type.STRING },
      location: { type: Type.STRING },
      city: { type: Type.STRING },
      roleType: { type: Type.STRING },
      postedDate: { type: Type.STRING },
      description: { type: Type.STRING },
    },
    required: ["title", "url", "sourceUrl", "location", "city", "roleType", "postedDate", "description"],
  },
};

async function extractJobs(ai: GoogleGenAI, employerName: string, documents: SourceDocument[]): Promise<ScannedJob[]> {
  if (documents.length === 0) return [];
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildExtractionPrompt(employerName, documents),
    config: {
      responseMimeType: "application/json",
      responseSchema: extractionSchema,
    },
  });
  return parseEvidenceBackedJobs(response.text || "", documents);
}

async function discoverCandidateUrls(ai: GoogleGenAI, employerName: string, website: string): Promise<string[]> {
  const response: any = await ai.models.generateContent({
    model: MODEL,
    contents: `Find official, currently open job-detail or job-search pages for "${employerName}" in Greater Philadelphia. The employer website is ${website}. Focus on the employer's site and its official applicant-tracking system. Do not use job-description aggregators or old cached postings.`,
    config: { tools: [{ googleSearch: {} }] },
  });

  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const urls = new Set<string>();
  for (const chunk of chunks) {
    const url = normalizeHttpUrl(chunk?.web?.uri);
    if (url) urls.add(url);
    if (urls.size >= 6) break;
  }
  return [...urls];
}

export async function scanJobsForEmployer(
  employerName: string,
  website: string,
  _existingTitles: string[] = [],
): Promise<ScanJobsResult> {
  const ai = getAIClient();
  if (!ai) {
    return {
      jobs: [],
      source: "no-jobs-found",
      authoritative: false,
      error: "GEMINI_API_KEY is missing or invalid in the server environment.",
    };
  }

  const targetUrl = normalizeHttpUrl(website);
  if (!targetUrl) {
    return {
      jobs: [],
      source: "no-jobs-found",
      authoritative: false,
      error: "A valid http(s) employer website is required.",
    };
  }

  let lastWarning = "No evidence-backed open positions were found.";
  const officialDocument = await fetchReadablePage(targetUrl);
  if (officialDocument) {
    try {
      const jobs = await extractJobs(ai, employerName, [officialDocument]);
      if (jobs.length > 0) {
        return { jobs, source: "official-page", authoritative: true };
      }
    } catch (error: any) {
      lastWarning = error?.message || "Could not extract jobs from the official page.";
      console.warn(`[Job scanner] Official-page extraction failed for ${employerName}:`, error);
    }
  }

  try {
    const candidateUrls = await discoverCandidateUrls(ai, employerName, targetUrl);
    const candidateDocuments = (await Promise.all(candidateUrls.map(fetchReadablePage)))
      .filter((document): document is SourceDocument => Boolean(document));
    const jobs = await extractJobs(ai, employerName, candidateDocuments);
    if (jobs.length > 0) {
      return { jobs, source: "grounded-pages", authoritative: false };
    }
  } catch (error: any) {
    lastWarning = error?.message || "Grounded job-page discovery failed.";
    console.warn(`[Job scanner] Grounded discovery failed for ${employerName}:`, error);
  }

  return {
    jobs: [],
    source: "no-jobs-found",
    authoritative: Boolean(officialDocument),
    warning: lastWarning,
  };
}
