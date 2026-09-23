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

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const SEARCH_GROUNDING_ENABLED = process.env.GEMINI_ENABLE_SEARCH_GROUNDING === "true";
const MAX_DOCUMENT_CHARS = 80_000;
const MAX_SOURCE_DOCUMENTS = 5;
const READER_TIMEOUT_MS = 12_000;
const ATS_HOST_PATTERN = /(?:^|\.)(?:myworkdayjobs\.com|greenhouse\.io|lever\.co|taleo\.net|oraclecloud\.com|icims\.com|smartrecruiters\.com|ultipro\.com|ukg\.com|bamboohr\.com|adp\.com|jobvite\.com|paylocity\.com|dayforcehcm\.com|successfactors\.com|sapsf\.com)$/i;

export function hasGeminiApiKey(): boolean {
  const key = process.env.GEMINI_API_KEY || "";
  return Boolean(key && key !== "MY_GEMINI_API_KEY");
}

function getAIClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY || "";
  if (!hasGeminiApiKey()) return null;

  try {
    return new GoogleGenAI({ apiKey: key });
  } catch (error) {
    console.error("Failed to initialize GoogleGenAI:", error);
    return null;
  }
}

/** Converts upstream SDK failures into actionable messages without exposing secrets. */
export function describeGeminiError(error: unknown): string {
  const candidate = error as { message?: unknown; status?: unknown; code?: unknown } | null;
  const rawMessage = String(candidate?.message || "");
  const normalized = rawMessage.toLowerCase();
  const status = Number(candidate?.status || candidate?.code || 0) || undefined;

  if (
    status === 401 ||
    /api key not valid|invalid api key|unauthenticated|authentication credential/.test(normalized)
  ) {
    return "Gemini rejected the configured API key. Replace GEMINI_API_KEY in Vercel with a current Google AI Studio key, then redeploy.";
  }
  if (
    status === 403 ||
    /permission denied|permission_denied|access restricted|not authorized/.test(normalized)
  ) {
    return "Gemini denied access for this API key. Confirm the key's Google Cloud project has Gemini API access and free-tier availability, then redeploy.";
  }
  if (status === 429 || /resource_exhausted|quota|rate limit|too many requests/.test(normalized)) {
    return "The free Gemini quota or rate limit was reached. Wait for the quota to reset; official ATS sources can still be scanned without paid grounding.";
  }
  if (status === 404 || /model.+not found|not found.+model|not supported for generatecontent/.test(normalized)) {
    return `Gemini model ${MODEL} is unavailable to this API key. Set GEMINI_MODEL to an available stable Flash model in Vercel, then redeploy.`;
  }
  if (/timeout|timed out|deadline|aborterror/.test(normalized)) {
    return "The Gemini request timed out before the scan completed. Please retry this employer.";
  }
  if (status === 400) {
    return `Gemini rejected the scan request (400) for model ${MODEL}. Check the Vercel function logs for the upstream validation message.`;
  }

  return status
    ? `Gemini could not complete the scan (upstream status ${status}). Check the Vercel function logs for details.`
    : "Gemini could not complete the scan. Check the Vercel function logs for details.";
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

function isGreaterPhiladelphiaLocation(city: string, state: string, postalCode: string): boolean {
  const normalizedCity = normalizeEvidence(city);
  const normalizedState = state.trim().toUpperCase();
  if (normalizedState !== "PA" && normalizedState !== "NJ") return false;
  const localCities = [
    "philadelphia", "wayne", "radnor", "king of prussia", "conshohocken", "malvern",
    "west chester", "chester", "media", "bala cynwyd", "bryn mawr", "fort washington",
    "horsham", "blue bell", "plymouth meeting", "norristown", "lansdale", "doylestown",
    "newtown", "yardley", "bensalem", "trevose", "exton", "paoli", "berwyn",
    "jenkintown", "willow grove", "camden", "cherry hill", "mount laurel", "moorestown",
  ];
  if (localCities.includes(normalizedCity)) {
    return true;
  }
  return normalizedState === "NJ" && /^(080|081)/.test(postalCode.trim());
}

function getAdpCustomField(
  requisition: Record<string, any>,
  collection: "dateFields" | "stringFields",
  code: string,
): string {
  const fields = requisition?.customFieldGroup?.[collection];
  if (!Array.isArray(fields)) return "";
  const field = fields.find((candidate: any) => candidate?.nameCode?.codeValue === code);
  return String(field?.dateValue || field?.stringValue || "").trim();
}

/** Parses official ADP Workforce Now requisitions without requiring a search API. */
export function parseAdpJobs(payload: unknown, boardUrl: string): ScannedJob[] {
  const requisitions = (payload as any)?.jobRequisitions;
  if (!Array.isArray(requisitions)) return [];

  const jobs: ScannedJob[] = [];
  for (const requisition of requisitions) {
    const title = String(requisition?.requisitionTitle || "").trim();
    const itemId = String(requisition?.itemID || requisition?.clientRequisitionID || "").trim();
    const locations = Array.isArray(requisition?.requisitionLocations)
      ? requisition.requisitionLocations
      : [];
    const localLocation = locations.find((location: any) => {
      const address = location?.address || {};
      return isGreaterPhiladelphiaLocation(
        String(address.cityName || ""),
        String(address.countrySubdivisionLevel1?.codeValue || ""),
        String(address.postalCode || ""),
      );
    });
    if (!title || !itemId || !localLocation) continue;

    const address = localLocation.address || {};
    const city = String(address.cityName || "").trim();
    const state = String(address.countrySubdivisionLevel1?.codeValue || "").trim();
    const titleStates = [...title.matchAll(/,\s*([A-Z]{2})\b/g)].map((match) => match[1]);
    if (titleStates.length > 0 && !titleStates.includes(state.toUpperCase())) continue;

    const jobUrl = new URL(boardUrl);
    jobUrl.searchParams.set("jobId", itemId);
    jobs.push({
      title,
      url: jobUrl.href,
      location: [city, state].filter(Boolean).join(", "),
      city,
      roleType: String(requisition?.workLevelCode?.shortName || "Not specified").trim(),
      postedDate: getAdpCustomField(requisition, "dateFields", "PostingDate") || String(requisition?.postDate || ""),
      description: "",
    });
  }
  return jobs;
}

async function fetchAdpJobs(boardUrl: string): Promise<ScannedJob[]> {
  try {
    const board = new URL(boardUrl);
    const cid = board.searchParams.get("cid");
    const ccId = board.searchParams.get("ccId");
    if (!cid || !ccId) return [];

    const endpoint = new URL("/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions", board.origin);
    endpoint.searchParams.set("cid", cid);
    endpoint.searchParams.set("ccId", ccId);
    endpoint.searchParams.set("lang", "en_US");
    endpoint.searchParams.set("locale", "en_US");
    endpoint.searchParams.set("$skip", "0");
    endpoint.searchParams.set("$top", "100");
    endpoint.searchParams.set("userQuery", "");

    const response = await fetch(endpoint, {
      headers: {
        "Accept-Language": "en_US",
        locale: "en_US",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/json",
        "x-forwarded-host": board.hostname,
      },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    return parseAdpJobs(await response.json(), board.href);
  } catch (error) {
    console.warn(`[Job scanner] Could not read ADP board ${boardUrl}:`, error);
    return [];
  }
}

/** Maps currently listed UKG Pro opportunities to their official detail pages. */
export function parseUkgJobs(payload: unknown, boardUrl: string): ScannedJob[] {
  const opportunities = (payload as any)?.opportunities;
  if (!Array.isArray(opportunities)) return [];

  const board = new URL(boardUrl);
  board.search = "";
  board.hash = "";
  const jobs: ScannedJob[] = [];
  const seen = new Set<string>();
  for (const opportunity of opportunities) {
    const id = String(opportunity?.Id || "");
    const title = String(opportunity?.Title || "").trim();
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id) || !title || seen.has(id)) continue;

    const location = (Array.isArray(opportunity.Locations) ? opportunity.Locations : []).find((candidate: any) => {
      const address = candidate?.Address || {};
      return isGreaterPhiladelphiaLocation(
        String(address.City || ""),
        String(address.State?.Code || ""),
        String(address.PostalCode || ""),
      );
    });
    if (!location) continue;

    const address = location.Address;
    const city = String(address.City || "").trim();
    const state = String(address.State.Code || "").trim();
    const detailUrl = new URL("OpportunityDetail", board);
    detailUrl.searchParams.set("opportunityId", id);
    jobs.push({
      title,
      url: detailUrl.href,
      location: `${city}, ${state}`,
      city,
      roleType: typeof opportunity.FullTime === "boolean"
        ? opportunity.FullTime ? "Full-time" : "Part-time"
        : "Not specified",
      postedDate: String(opportunity.PostedDate || ""),
      description: String(opportunity.BriefDescription || ""),
    });
    seen.add(id);
  }
  return jobs;
}

async function fetchUkgJobs(boardUrl: string): Promise<ScannedJob[]> {
  try {
    const board = new URL(boardUrl);
    if (!board.hostname.toLowerCase().endsWith(".rec.pro.ukg.net")) return [];
    const boardPath = board.pathname.match(/^\/(?:[^/]+)\/JobBoard\/[a-f\d-]{36}\//i);
    if (!boardPath) return [];
    const endpoint = new URL(`${boardPath[0]}JobBoardView/LoadSearchResults`, board.origin);
    const jobs = new Map<string, ScannedJob>();
    const pageSize = 200;
    for (let page = 0; page < 5; page += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ opportunitySearch: { QueryString: "", Filters: [], Top: pageSize, Skip: page * pageSize } }),
        signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      });
      if (!response.ok) break;
      const payload = await response.json();
      for (const job of parseUkgJobs(payload, new URL(boardPath[0], board.origin).href)) {
        jobs.set(job.url, job);
      }
      const received = Array.isArray(payload?.opportunities) ? payload.opportunities.length : 0;
      if (!received || received < pageSize || (page + 1) * pageSize >= Number(payload?.totalCount || 0)) break;
    }
    return [...jobs.values()];
  } catch (error) {
    console.warn(`[Job scanner] Could not read UKG board ${boardUrl}:`, error);
    return [];
  }
}

async function extractStructuredAtsJobs(documents: SourceDocument[]): Promise<ScannedJob[]> {
  for (const document of documents) {
    try {
      const hostname = new URL(document.url).hostname.toLowerCase();
      if (hostname === "adp.com" || hostname.endsWith(".adp.com")) {
        const jobs = await fetchAdpJobs(document.url);
        if (jobs.length > 0) return jobs;
      }
      if (hostname.endsWith(".rec.pro.ukg.net")) {
        const jobs = await fetchUkgJobs(document.url);
        if (jobs.length > 0) return jobs;
      }
    } catch {
      // Ignore malformed source URLs; normal evidence extraction remains available.
    }
  }
  return [];
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

/** Returns the strongest job-board and ATS links exposed by a careers page. */
export function extractLikelyCareerLinks(document: SourceDocument): string[] {
  const scored = new Map<string, number>();
  const sourceUrl = normalizeHttpUrl(document.url);
  const sourceHost = sourceUrl ? new URL(sourceUrl).hostname : "";

  const scoreLink = (rawLabel: string, rawUrl: string) => {
    const label = normalizeEvidence(rawLabel.replace(/<[^>]+>/g, " "));
    const url = normalizeHttpUrl(rawUrl.replace(/&amp;/gi, "&"), document.url);
    if (!url || comparableUrl(url) === comparableUrl(document.url)) return;

    const parsed = new URL(url);
    if (/\.(?:css|js|jpe?g|png|gif|svg|webp|pdf|mp4)$/i.test(parsed.pathname)) return;
    if (/facebook|instagram|linkedin|twitter|youtube|vimeo|google\.com\/maps/i.test(parsed.hostname + parsed.pathname)) return;

    let score = 0;
    if (ATS_HOST_PATTERN.test(parsed.hostname)) score += 100;
    if (/open positions?|current openings?|view all jobs?|search (?:and )?apply|search jobs?|external candidate|career site|apply now/.test(label)) score += 80;
    if (/\/(?:job|jobs|careers?|employment)(?:\/|$)|careersection|jobsearch|recruitment|view-all-jobs/i.test(parsed.pathname)) score += 45;
    if (/\/job(?:-invite)?\//i.test(parsed.pathname)) score += 35;
    if (parsed.hostname === sourceHost) score += 10;
    if (/how-we-hire|applicant-tips|benefits|diversity|ethics|privacy|talent-community/i.test(parsed.pathname)) score -= 80;

    if (score >= 55) scored.set(url, Math.max(score, scored.get(url) || 0));
  };

  for (const match of document.text.matchAll(/\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/gi)) {
    scoreLink(match[1], match[2]);
  }
  for (const match of document.text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    scoreLink(match[2], match[1]);
  }

  return [...scored.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([url]) => url);
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
    const readerUrl = `https://r.jina.ai/${normalized}`;
    let response = await fetch(readerUrl, {
      headers: {
        Accept: "text/plain",
        "X-With-Links-Summary": "all",
        "X-With-Iframe": "true",
      },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
    // Some sites reject advanced rendering options even though basic Reader works.
    if ([400, 401, 422].includes(response.status)) {
      response = await fetch(readerUrl, {
        headers: { Accept: "text/plain", "X-Respond-With": "html" },
        signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      });
    }
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

async function collectCareerDocuments(root: SourceDocument): Promise<SourceDocument[]> {
  const documents = [root];
  const visited = new Set<string>([comparableUrl(root.url)]);
  let frontier = extractLikelyCareerLinks(root);

  for (let depth = 0; depth < 2 && frontier.length > 0 && documents.length < MAX_SOURCE_DOCUMENTS; depth += 1) {
    const remaining = MAX_SOURCE_DOCUMENTS - documents.length;
    const batch = frontier
      .filter((url) => !visited.has(comparableUrl(url)))
      .slice(0, Math.min(2, remaining));
    batch.forEach((url) => visited.add(comparableUrl(url)));

    const fetched = (await Promise.all(batch.map(fetchReadablePage)))
      .filter((document): document is SourceDocument => Boolean(document));
    documents.push(...fetched);
    frontier = fetched
      .flatMap(extractLikelyCareerLinks)
      .filter((url) => !visited.has(comparableUrl(url)));
  }

  return documents;
}

function fitDocumentToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const headLength = Math.floor(budget * 0.6);
  const tailLength = budget - headLength;
  return `${text.slice(0, headLength)}\n\n[...middle omitted...]\n\n${text.slice(-tailLength)}`;
}

function buildExtractionPrompt(employerName: string, documents: SourceDocument[]): string {
  const perDocumentBudget = Math.floor(MAX_DOCUMENT_CHARS / Math.max(1, documents.length));
  const sources = documents.map((document, index) =>
    `SOURCE ${index + 1}\nSOURCE_URL: ${document.url}\n${fitDocumentToBudget(document.text, perDocumentBudget)}`,
  ).join("\n\n---\n\n");

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
  let lastError: unknown = null;
  const officialDocument = await fetchReadablePage(targetUrl);
  if (officialDocument) {
    try {
      const documents = await collectCareerDocuments(officialDocument);
      const structuredJobs = await extractStructuredAtsJobs(documents);
      if (structuredJobs.length > 0) {
        return { jobs: structuredJobs, source: "official-page", authoritative: true };
      }
      const jobs = await extractJobs(ai, employerName, documents);
      lastError = null;
      if (jobs.length > 0) {
        return { jobs, source: "official-page", authoritative: true };
      }
    } catch (error: any) {
      lastError = error;
      lastWarning = error?.message || "Could not extract jobs from the official page.";
      console.warn(`[Job scanner] Official-page extraction failed for ${employerName}:`, error);
    }
  }

  if (SEARCH_GROUNDING_ENABLED) {
    try {
      const candidateUrls = await discoverCandidateUrls(ai, employerName, targetUrl);
      const candidateDocuments = (await Promise.all(candidateUrls.map(fetchReadablePage)))
        .filter((document): document is SourceDocument => Boolean(document));
      if (candidateDocuments.length > 0) {
        const jobs = await extractJobs(ai, employerName, candidateDocuments);
        lastError = null;
        if (jobs.length > 0) {
          return { jobs, source: "grounded-pages", authoritative: false };
        }
      }
    } catch (error: any) {
      lastError = error;
      lastWarning = error?.message || "Grounded job-page discovery failed.";
      console.warn(`[Job scanner] Grounded discovery failed for ${employerName}:`, error);
    }
  } else if (!lastError) {
    lastWarning = "No evidence-backed regional openings were found on the employer's official pages. Paid search fallback is disabled.";
  }

  if (lastError) {
    return {
      jobs: [],
      source: "no-jobs-found",
      authoritative: false,
      error: describeGeminiError(lastError),
    };
  }

  return {
    jobs: [],
    source: "no-jobs-found",
    authoritative: Boolean(officialDocument),
    warning: lastWarning,
  };
}
