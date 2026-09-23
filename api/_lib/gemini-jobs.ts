import { GoogleGenAI, Type } from "@google/genai";
import { INITIAL_EMPLOYERS } from "../../src/constants.js";

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
const DIRECT_TIMEOUT_MS = 7_000;
const BANK_SEARCH_ORIGIN = "https://careers.bankofamerica.com";
const SANTANDER_SEARCH = "https://www.santandercareers.com/search-jobs/Philadelphia%2C%20PA/1771/4/6252001-6254927/39x9526/-75x1636/50/2";
const SEPTA_ALL_JOBS = "https://jobs.septa.org/go/View-All-Jobs/8606400/";
// PHMC links to this same official UKG board from its careers page. Keep it as
// a direct path so intermittent corporate-site responses do not hide openings.
const PHMC_BOARD = "https://recruiting.ultipro.com/PUB1002/JobBoard/c8784846-358b-1bec-45e9-f994af5fccee/";
const OFFICIAL_HOSTS = new Set(INITIAL_EMPLOYERS.map((employer) => new URL(employer.website).hostname.toLowerCase()));
const LEGACY_CAREER_URLS = new Map([
  ["https://careers.upenn.edu/", "https://www.hr.upenn.edu/PennHR/careers-at-penn"],
  ["https://wacphila.org/about/careers", "https://wacphila.org/join-our-team/"],
  ["https://www.acelero.net/careers", "https://acelerolearning.com/careers/"],
  ["https://www.centercityphila.org/about/jobs", "https://centercityphila.org/who-we-are/careers/"],
  ["https://www.justborn.com/careers", "https://www.justborn.com/join-our-team"],
]);
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
  if ([502, 503, 504].includes(status || 0)) {
    return "Gemini is temporarily unavailable after retries. Try this employer again later; no paid upgrade is required for this error.";
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
    "newtown", "yardley", "bensalem", "trevose", "feasterville-trevose", "exton", "paoli", "berwyn",
    "jenkintown", "willow grove", "camden", "cherry hill", "mount laurel", "moorestown", "haddonfield",
    "upper darby", "springfield", "broomall", "glen mills", "warrington", "southampton", "lahaska",
    "elkins park gardens", "wyncote", "langhorne", "borough of langhorne",
    "harleysville", "north wales",
  ];
  if (normalizedState === "NJ") {
    return ["camden", "cherry hill", "mount laurel", "moorestown", "haddonfield"].includes(normalizedCity) ||
      /^(080|081)/.test(postalCode.trim());
  }
  return localCities.includes(normalizedCity);
}

/** Bank of America's public careers search is populated by this first-party JSON feed. */
export function parseBankOfAmericaJobs(payload: unknown): ScannedJob[] {
  const listings = (payload as { jobsList?: unknown })?.jobsList;
  if (!Array.isArray(listings)) return [];

  const jobs = new Map<string, ScannedJob>();
  for (const listing of listings) {
    const title = String(listing?.postingTitle || "").trim();
    const path = String(listing?.jcrURL || "").trim();
    if (!title || !/^\/en-us\/job-detail\/\d{4,}\/[^/?#]+$/i.test(path)) continue;
    const primaryState = String(listing?.state || "").trim();
    const state = primaryState === "Pennsylvania" ? "PA" : primaryState === "New Jersey" ? "NJ" : "";
    const city = String(listing?.city || "").trim();
    const primaryLocal = listing?.country === "United States" &&
      isGreaterPhiladelphiaLocation(city, state, "") &&
      (state !== "NJ" || ["camden", "cherry hill", "mount laurel", "moorestown"].includes(normalizeEvidence(city)));
    const otherLocations = String(listing?.additionalLocations || "").split(",");
    const localSecondary = otherLocations.map((location) =>
      location.match(/^US - (PA|NJ) - (.+?) - /i))
      .find((parts) => parts && isGreaterPhiladelphiaLocation(parts[2], parts[1], "") &&
        (parts[1].toUpperCase() !== "NJ" || ["camden", "cherry hill", "mount laurel", "moorestown"].includes(normalizeEvidence(parts[2]))));
    if (!primaryLocal && !localSecondary) continue;

    const localCity = primaryLocal ? city : localSecondary![2].trim();
    const localState = primaryLocal ? state : localSecondary![1].toUpperCase();
    const url = new URL(path, BANK_SEARCH_ORIGIN).href;
    jobs.set(url, { title, url, city: localCity, location: `${localCity}, ${localState}`,
      roleType: "Not specified", postedDate: String(listing?.postedDate || "").trim(), description: "" });
  }
  return [...jobs.values()];
}

async function fetchBankOfAmericaJobs(): Promise<ScannedJob[]> {
  try {
    const jobs = new Map<string, ScannedJob>();
    for (const state of ["Pennsylvania", "New Jersey"]) {
      let total = 0;
      let initialTotal: number | null = null;
      for (let start = 0; start === 0 || start < total; start += 100) {
        // Fail closed if the API changes or a page is unavailable: partial lists aren't complete scans.
        if (start >= 1_000) return [];
        const endpoint = new URL("/services/jobssearchservlet", BANK_SEARCH_ORIGIN);
        for (const [key, value] of Object.entries({ search: "jobsByStateCountry", state,
          country: "United States", start: String(start), rows: String(start + 100) })) endpoint.searchParams.set(key, value);
        const response = await fetch(endpoint, { headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(READER_TIMEOUT_MS) });
        if (!response.ok) return [];
        const payload = await response.json();
        if (!Array.isArray(payload?.jobsList) || !Number.isSafeInteger(payload?.totalMatches) ||
            payload.totalMatches < 0 || (initialTotal !== null && initialTotal !== payload.totalMatches) ||
            payload.jobsList.length < Math.min(100, payload.totalMatches - start)) return [];
        initialTotal = payload.totalMatches;
        total = payload.totalMatches;
        for (const job of parseBankOfAmericaJobs(payload)) jobs.set(job.url, job);
      }
    }
    return [...jobs.values()];
  } catch (error) {
    console.warn("[Job scanner] Bank of America official job feed unavailable:", error);
    return [];
  }
}

/** The official Santander search renders a paginated list of currently open jobs in HTML. */
export function parseSantanderJobs(html: string): ScannedJob[] {
  const region = html.match(/<ul\b[^>]*id="search-results-jobs"[^>]*>/i);
  if (!region) return [];
  const end = html.indexOf('<nav id="pagination-bottom"', region.index);
  if (end < 0) return [];
  const section = html.slice(region.index, end);
  const jobs: ScannedJob[] = [];
  const entries = section.split(/<li\s+class="search-results-list__item"[^>]*>/i).slice(1);
  for (const entry of entries) {
    const match = entry.match(/<a\s+class="search-results-list__job-link"\s+href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<li\s+class="[^"]*\bjob-location"[^>]*>\s*([^<]+)<\/li>/i);
    if (!match) continue;
    const path = match[1].replace(/&amp;/g, "&");
    if (!/^\/job\/[\w-]+\/[\w-]+\/1771\/\d+$/i.test(path)) continue;
    const location = match[3].trim();
    const locationMatch = location.match(/^(.+),\s*(PA|NJ)$/i);
    if (!locationMatch || !isGreaterPhiladelphiaLocation(locationMatch[1], locationMatch[2], "")) continue;
    if (locationMatch[2].toUpperCase() === "NJ" &&
        !["camden", "cherry hill", "mount laurel", "moorestown"].includes(normalizeEvidence(locationMatch[1]))) continue;
    const city = locationMatch[1].trim();
    const title = match[2].replace(/&amp;/g, "&").replace(/&#(?:39|x27);/gi, "'").trim();
    if (!title) continue;
    jobs.push({ title, url: new URL(path, SANTANDER_SEARCH).href, city,
      location: `${city}, ${locationMatch[2].toUpperCase()}`, roleType: "Not specified", postedDate: "", description: "" });
  }
  return jobs;
}

async function fetchSantanderJobs(): Promise<ScannedJob[]> {
  try {
    const jobs = new Map<string, ScannedJob>();
    let total: number | null = null;
    let seenListings = 0;
    for (let page = 1; page <= 20; page += 1) {
      const url = new URL(SANTANDER_SEARCH);
      if (page > 1) url.searchParams.set("p", String(page));
      const response = await fetch(url, { headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(READER_TIMEOUT_MS) });
      if (!response.ok) return [];
      const html = await response.text();
      const count = Number(html.match(/id="search-results-jobs"[^>]*data-results-count="(\d+)"/i)?.[1]);
      const pagination = html.match(/currently on page (\d+) \/ (\d+)/i);
      const pageCount = Number(pagination?.[2]);
      const pageListings = (html.match(/class="search-results-list__job-link"/g) || []).length;
      if (!Number.isSafeInteger(count) || !count || !Number.isSafeInteger(pageCount) || pageCount > 20 ||
          Number(pagination?.[1]) !== page || pageCount < page || !pageListings ||
          (total !== null && count !== total)) return [];
      total = count;
      seenListings += pageListings;
      for (const job of parseSantanderJobs(html)) jobs.set(job.url, job);
      if (page === pageCount) return seenListings === count ? [...jobs.values()] : [];
    }
    return [];
  } catch (error) {
    console.warn("[Job scanner] Santander official search unavailable:", error);
    return [];
  }
}

/** Use location evidence from the current Workday search results (or their detail pages). */
export function parseWorkdayJobs(postings: unknown, boardUrl: string): ScannedJob[] {
  if (!Array.isArray(postings)) return [];
  const jobs = new Map<string, ScannedJob>();
  for (const posting of postings) {
    const path = String(posting?.externalPath || "");
    const title = String(posting?.title || "").trim();
    if (!title || !/^\/job\/[\w%.-]+\/[\w%.-]+$/i.test(path)) continue;
    const locations = Array.isArray(posting?.locations) ? posting.locations : [posting?.locationsText];
    const local = locations.map((location: unknown) => String(location || "").match(/^(.+?),\s*(PA|NJ)$/i))
      .find((parts) => parts && isGreaterPhiladelphiaLocation(parts[1], parts[2], "") &&
        (parts[2].toUpperCase() !== "NJ" || ["camden", "cherry hill", "mount laurel", "moorestown", "haddonfield"].includes(normalizeEvidence(parts[1]))));
    if (!local) continue;
    const city = local[1].trim();
    const url = new URL(`/en-US/${new URL(boardUrl).pathname.split("/").filter(Boolean).pop()}${path}`,
      boardUrl).href;
    jobs.set(url, { title, url, location: `${city}, ${local[2].toUpperCase()}`, city,
      roleType: "Not specified", postedDate: "", description: "" });
  }
  return [...jobs.values()];
}

async function fetchWorkdayJobs(boardUrl: string): Promise<ScannedJob[]> {
  try {
    const board = new URL(boardUrl);
    const tenant = board.hostname.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i)?.[1];
    const site = board.pathname.match(/^\/(?:en-US\/)?([a-z0-9_-]+)\/?$/i)?.[1];
    if (!tenant || !site) return [];
    const endpoint = new URL(`/wday/cxs/${tenant}/${site}`, board.origin);
    const postings: any[] = [];
    for (const searchText of ["Pennsylvania", "New Jersey"]) {
      let total: number | null = null;
      for (let offset = 0; offset === 0 || offset < total!; offset += 20) {
        if (offset >= 200) return [];
        const response = await fetch(`${endpoint.href}/jobs`, { method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }),
          signal: AbortSignal.timeout(READER_TIMEOUT_MS) });
        if (!response.ok) return [];
        const data = await response.json();
        if (!Number.isSafeInteger(data?.total) || !Array.isArray(data?.jobPostings) ||
            (total !== null && data.total !== 0 && total !== data.total) ||
            data.jobPostings.length < Math.min(20, (total ?? data.total) - offset)) return [];
        total ??= data.total;
        postings.push(...data.jobPostings);
      }
    }
    // Workday abbreviates multi-site postings as "N Locations"; read those details
    // instead of silently dropping an opening that may be based in Philadelphia.
    for (let index = 0; index < postings.length; index += 1) {
      const posting = postings[index];
      if (!/^\d+ Locations$/i.test(String(posting?.locationsText || ""))) continue;
      const path = String(posting?.externalPath || "");
      if (!/^\/job\/[\w%.-]+\/[\w%.-]+$/i.test(path)) return [];
      const response = await fetch(`${endpoint.href}${path}`, { headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(READER_TIMEOUT_MS) });
      if (!response.ok) return [];
      const detail = (await response.json())?.jobPostingInfo;
      if (!detail || !Array.isArray(detail.additionalLocations)) return [];
      posting.locations = [detail.location, ...detail.additionalLocations];
    }
    return parseWorkdayJobs(postings, board.href);
  } catch (error) {
    console.warn(`[Job scanner] Workday board unavailable for ${boardUrl}:`, error);
    return [];
  }
}

/** SmartRecruiters publishes an unauthenticated, first-party feed for each public company board. */
export function parseSmartRecruitersJobs(payload: unknown, company: string): ScannedJob[] {
  const postings = (payload as { content?: unknown })?.content;
  if (!Array.isArray(postings)) return [];
  const jobs = new Map<string, ScannedJob>();
  for (const posting of postings) {
    const id = String(posting?.id || "");
    const title = String(posting?.name || "").trim();
    const city = String(posting?.location?.city || "").trim();
    const region = String(posting?.location?.region || "").trim();
    const state = region.toLowerCase() === "pennsylvania" ? "PA" :
      region.toLowerCase() === "new jersey" ? "NJ" : region;
    if (!/^\d+$/.test(id) || !title ||
        String(posting?.company?.identifier || "") !== company ||
        String(posting?.visibility || "") !== "PUBLIC" ||
        !isGreaterPhiladelphiaLocation(city, state, String(posting?.location?.postalCode || ""))) continue;
    const url = `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${id}`;
    jobs.set(url, { title, url, location: `${city}, ${state}`, city,
      roleType: String(posting?.typeOfEmployment?.label || "Not specified"),
      postedDate: String(posting?.releasedDate || ""), description: "" });
  }
  return [...jobs.values()];
}

async function fetchSmartRecruitersJobs(boardUrl: string): Promise<ScannedJob[]> {
  try {
    const board = new URL(boardUrl);
    if (board.hostname !== "careers.smartrecruiters.com") return [];
    const company = board.pathname.match(/^\/([a-z0-9_-]+)\/?$/i)?.[1];
    if (!company) return [];
    const jobs = new Map<string, ScannedJob>();
    let total: number | null = null;
    for (let offset = 0; offset === 0 || offset < total!; offset += 100) {
      if (offset >= 1000) return [];
      const response = await fetch(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100&offset=${offset}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(READER_TIMEOUT_MS) });
      if (!response.ok) return [];
      const payload = await response.json();
      if (!Number.isSafeInteger(payload?.totalFound) || !Array.isArray(payload?.content) ||
          (total !== null && payload.totalFound !== total) ||
          payload.content.length < Math.min(100, (total ?? payload.totalFound) - offset)) return [];
      total ??= payload.totalFound;
      for (const job of parseSmartRecruitersJobs(payload, company)) jobs.set(job.url, job);
    }
    return [...jobs.values()];
  } catch (error) {
    console.warn(`[Job scanner] SmartRecruiters board unavailable for ${boardUrl}:`, error);
    return [];
  }
}

/** SEPTA's official SuccessFactors career site server-renders every search tile. */
export function parseSeptaJobs(html: string): ScannedJob[] {
  const pageSize = Number(html.match(/jobRecordsPerPage: parseInt\("(\d+)"\)/)?.[1]);
  const total = Number(html.match(/jobRecordsFound: parseInt\("(\d+)"\)/)?.[1]);
  if (!Number.isSafeInteger(total) || !total || !Number.isSafeInteger(pageSize) || total > pageSize) return [];
  const tiles = [...html.matchAll(/<li class="job-tile\b[^>]*data-url="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gi)];
  if (tiles.length !== total) return [];
  const jobs = new Map<string, ScannedJob>();
  for (const [, rawPath, tile] of tiles) {
    const path = rawPath.replace(/&amp;/g, "&");
    const title = tile.match(/class="jobTitle-link[^"]*"[^>]*href="[^"]+"[^>]*>([^<]+)/i)?.[1]
      ?.replace(/&amp;/g, "&").trim();
    const city = tile.match(/id="job-\d+-desktop-section-city-value"[^>]*>\s*([^<]+)/i)?.[1]?.trim();
    if (!title || !city || !/^\/job\/[\w%.&()-]+\/\d+\/$/i.test(path)) return [];
    if (!isGreaterPhiladelphiaLocation(city, "PA", "")) continue;
    const url = new URL(path, SEPTA_ALL_JOBS).href;
    jobs.set(url, { title, url, city, location: `${city}, PA`, roleType: "Not specified",
      postedDate: "", description: "" });
  }
  return [...jobs.values()];
}

async function fetchSeptaJobs(): Promise<ScannedJob[]> {
  try {
    const response = await fetch(SEPTA_ALL_JOBS, { headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS) });
    return response.ok ? parseSeptaJobs(await response.text()) : [];
  } catch (error) {
    console.warn("[Job scanner] SEPTA's official jobs page unavailable:", error);
    return [];
  }
}

/** Only CCD's own, currently displayed accordion listings, not partner-company jobs. */
export function parseCenterCityJobs(html: string): ScannedJob[] {
  const section = html.match(/<h2>\s*CCD open positions\s*<\/h2>([\s\S]*?)(?=<h2>\s*CCD partner open positions\s*<\/h2>)/i)?.[1];
  if (!section) return [];
  const cards = section.split(/<div class="accordion_item"[^>]*>/i).slice(1);
  if (!cards.length) return [];
  const jobs: ScannedJob[] = [];
  for (const card of cards) {
    const title = card.match(/<div class="accordion_header"[^>]*>\s*([^<]+)</i)?.[1]
      ?.replace(/&amp;/g, "&").trim();
    if (!title) return [];
    if (/^don.t see the job you are looking for\?/i.test(title)) continue;
    const url = card.match(/<a\b[^>]*href="(https:\/\/www\.paycomonline\.net\/v4\/ats\/web\.php\/portal\/[A-F\d]{32}\/(?:jobs\/\d+|career-page))"[^>]*>\s*Learn More\s*<\/a>/i)?.[1];
    if (!url) return [];
    jobs.push({ title, url, city: "Philadelphia", location: "Philadelphia, PA",
      roleType: "Not specified", postedDate: "", description: "" });
  }
  return jobs;
}

/** Newman lists its current openings and their official detail links on its careers page. */
export function parseNewmanJobs(html: string): ScannedJob[] {
  const cards = [...html.matchAll(/<div class="careers-posting_container">([\s\S]*?)<p class="careers-posting_container_row_brief">/gi)];
  const jobs: ScannedJob[] = [];
  for (const [, card] of cards) {
    const title = card.match(/<h3>\s*([^<]+)\s*<\/h3>/i)?.[1]?.trim();
    const url = card.match(/href="(https:\/\/newmanpaperboard\.com\/job\/[a-z0-9-]+\/)"/i)?.[1];
    if (title && url) jobs.push({ title, url, city: "Philadelphia", location: "Philadelphia, PA",
      roleType: "Not specified", postedDate: "", description: "" });
  }
  return jobs;
}

async function fetchNewmanJobs(document: SourceDocument): Promise<ScannedJob[]> {
  const listings = parseNewmanJobs(document.text);
  if (!listings.length) return [];
  const jobs: ScannedJob[] = [];
  for (const job of listings) {
    const detail = await fetchOfficialHtml(job.url);
    // The detail page must still exist and explicitly place the opening locally.
    if (!detail) return [];
    if (/Philadelphia, PA|Philadelphia-based|city of Philadelphia/i.test(detail.text) &&
        !/position (?:has been )?filled|this job (?:is )?closed/i.test(detail.text)) jobs.push(job);
  }
  return jobs;
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
    if (!board.hostname.toLowerCase().endsWith(".rec.pro.ukg.net") &&
        board.hostname.toLowerCase() !== "recruiting.ultipro.com") return [];
    const boardPath = board.pathname.match(/^\/(?:[^/]+)\/JobBoard\/[a-f\d-]{36}\//i);
    if (!boardPath) return [];
    const endpoint = new URL(`${boardPath[0]}JobBoardView/LoadSearchResults`, board.origin);
    const jobs = new Map<string, ScannedJob>();
    const pageSize = 200;
    let expectedTotal: number | null = null;
    for (let page = 0; page < 5; page += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ opportunitySearch: { QueryString: "", Filters: [], Top: pageSize, Skip: page * pageSize } }),
        signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      if (!Array.isArray(payload?.opportunities)) return [];
      if (Number.isSafeInteger(payload.totalCount)) {
        if (expectedTotal !== null && expectedTotal !== payload.totalCount) return [];
        expectedTotal = payload.totalCount;
      }
      for (const job of parseUkgJobs(payload, new URL(boardPath[0], board.origin).href)) {
        jobs.set(job.url, job);
      }
      const received = payload.opportunities.length;
      if (expectedTotal !== null && (page * pageSize + received < Math.min(expectedTotal, (page + 1) * pageSize))) return [];
      if (!received || received < pageSize || (expectedTotal !== null && (page + 1) * pageSize >= expectedTotal)) {
        return [...jobs.values()];
      }
    }
    return [];
  } catch (error) {
    console.warn(`[Job scanner] Could not read UKG board ${boardUrl}:`, error);
    return [];
  }
}

/** Taleo's public search response contains open requisitions, including their actual board IDs. */
export function parseTaleoJobs(payload: unknown, boardUrl: string, districtLocation = false): ScannedJob[] {
  const requisitions = (payload as any)?.requisitionList;
  if (!Array.isArray(requisitions)) return [];
  const board = new URL(boardUrl);
  const jobs: ScannedJob[] = [];
  for (const requisition of requisitions) {
    const columns = requisition?.column;
    if (!Array.isArray(columns)) continue;
    const title = String(columns[0] || "").trim();
    const contestNo = String(requisition?.contestNo || "").trim();
    if (!title || !/^[\w-]{1,50}$/.test(contestNo)) continue;
    let locations: unknown;
    try {
      const locationIndex = Array.isArray(requisition.locationsColumns) ? requisition.locationsColumns[0] : 2;
      locations = JSON.parse(String(columns[locationIndex] || "[]"));
    } catch {
      continue;
    }
    if (!Array.isArray(locations)) continue;
    const local = locations.map((location) => String(location).match(/^United States-(Pennsylvania|New Jersey)-(.+)$/i))
      .find((parts) => parts && isGreaterPhiladelphiaLocation(parts[2], parts[1].toLowerCase() === "pennsylvania" ? "PA" : "NJ", ""));
    if (!local && !(districtLocation && board.hostname === "aa080.taleo.net" &&
        board.pathname.includes("/sdp_external_career_section/") && locations.length > 0 &&
        locations.every((location) => !/^(?:United States|Canada)-/i.test(String(location))))) continue;
    const city = local ? local[2].trim() : "Philadelphia";
    const state = local ? local[1].toLowerCase() === "pennsylvania" ? "PA" : "NJ" : "PA";
    const school = !local && districtLocation ? String(locations[0]).trim() : "";
    const detailUrl = new URL(board.pathname.replace(/jobsearch\.ftl$/i, "jobdetail.ftl"), board.origin);
    detailUrl.searchParams.set("job", contestNo);
    detailUrl.searchParams.set("lang", board.searchParams.get("lang") || "en");
    jobs.push({ title, url: detailUrl.href, location: school ? `${school}, ${city}, ${state}` : `${city}, ${state}`, city,
      roleType: "Not specified", postedDate: "", description: "" });
  }
  return jobs;
}

async function fetchTaleoJobs(boardUrl: string, districtLocation = false): Promise<ScannedJob[]> {
  try {
    const board = new URL(boardUrl);
    if (!/(?:^|\.)taleo\.net$/i.test(board.hostname) ||
        !/^\/careersection\/[^/]+\/jobsearch\.ftl$/i.test(board.pathname)) return [];
    const boardResponse = await fetch(board, { signal: AbortSignal.timeout(READER_TIMEOUT_MS) });
    if (!boardResponse.ok) return [];
    const html = await boardResponse.text();
    const portalNo = html.match(/\bportalNo\s*:\s*['"](\d+)['"]/i)?.[1];
    if (!portalNo) return [];
    const endpoint = new URL("/careersection/rest/jobboard/searchjobs", board.origin);
    endpoint.searchParams.set("lang", board.searchParams.get("lang") || "en");
    endpoint.searchParams.set("portal", portalNo);
    const jobs = new Map<string, ScannedJob>();
    for (let page = 1; page <= 10; page += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Referer: board.href,
          tz: "0", tzname: "UTC" },
        body: JSON.stringify({ pageNo: page }),
        signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      });
      if (!response.ok) break;
      const payload = await response.json();
      for (const job of parseTaleoJobs(payload, board.href, districtLocation)) jobs.set(job.url, job);
      const paging = payload?.pagingData;
      const count = Array.isArray(payload?.requisitionList) ? payload.requisitionList.length : 0;
      if (!count || !Number.isFinite(Number(paging?.pageSize)) ||
          page * Number(paging.pageSize) >= Number(paging?.totalCount || 0)) break;
    }
    return [...jobs.values()];
  } catch (error) {
    console.warn(`[Job scanner] Could not read Taleo board ${boardUrl}:`, error);
    return [];
  }
}

async function extractStructuredAtsJobs(documents: SourceDocument[]): Promise<ScannedJob[]> {
  const adpBoards = new Set<string>();
  const ukgBoards = new Set<string>();
  const taleoBoards = new Set<string>();
  const workdayBoards = new Set<string>();
  const smartRecruitersBoards = new Set<string>();
  for (const document of documents) {
    try {
      for (const url of [document.url, ...extractLikelyCareerLinks(document)]) {
        const board = new URL(url);
        const hostname = board.hostname.toLowerCase();
        if (hostname === "adp.com" || hostname.endsWith(".adp.com")) adpBoards.add(board.href);
        if (hostname.endsWith(".rec.pro.ukg.net") || hostname === "recruiting.ultipro.com") {
          const boardPath = board.pathname.match(/^\/(?:[^/]+)\/JobBoard\/[a-f\d-]{36}\//i);
          if (boardPath) ukgBoards.add(new URL(boardPath[0], board.origin).href);
        }
        if (/(?:^|\.)taleo\.net$/i.test(board.hostname) &&
            /^\/careersection\/[^/]+\/jobsearch\.ftl$/i.test(board.pathname)) taleoBoards.add(board.href);
        if (/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i.test(hostname) &&
            /^\/(?:en-US\/)?[a-z0-9_-]+\/?$/i.test(board.pathname)) workdayBoards.add(board.href);
        if (hostname === "careers.smartrecruiters.com" && /^\/[a-z0-9_-]+\/?$/i.test(board.pathname)) {
          smartRecruitersBoards.add(board.href);
        }
      }
    } catch {
      // Ignore malformed source URLs; normal evidence extraction remains available.
    }
  }
  for (const boardUrl of [...adpBoards].slice(0, 4)) {
    const jobs = await fetchAdpJobs(boardUrl);
    if (jobs.length > 0) return jobs;
  }
  for (const boardUrl of [...ukgBoards].slice(0, 4)) {
    const jobs = await fetchUkgJobs(boardUrl);
    if (jobs.length > 0) return jobs;
  }
  for (const boardUrl of [...workdayBoards].slice(0, 4)) {
    const jobs = await fetchWorkdayJobs(boardUrl);
    if (jobs.length > 0) return jobs;
  }
  for (const boardUrl of [...smartRecruitersBoards].slice(0, 4)) {
    const jobs = await fetchSmartRecruitersJobs(boardUrl);
    if (jobs.length > 0) return jobs;
  }
  const jobs = new Map<string, ScannedJob>();
  for (const boardUrl of [...taleoBoards].slice(0, 4)) {
    const districtLocation = documents.some((document) => new URL(document.url).hostname === "jobs.philasd.org") &&
      new URL(boardUrl).hostname === "aa080.taleo.net";
    for (const job of await fetchTaleoJobs(boardUrl, districtLocation)) jobs.set(job.url, job);
  }
  return [...jobs.values()];
}

/** First-party HTML is enough to discover ATS links when the Reader is slow or unavailable. */
async function fetchOfficialHtml(url: string): Promise<SourceDocument | null> {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" || !OFFICIAL_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  try {
    const initialHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const signal = AbortSignal.timeout(DIRECT_TIMEOUT_MS);
    let current = parsed;
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await fetch(current, {
        headers: { Accept: "text/html" }, redirect: "manual", signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return null;
        const next = new URL(location, current);
        if (next.protocol !== "https:" || next.hostname.toLowerCase().replace(/^www\./, "") !== initialHost ||
            next.username || next.password) return null;
        current = next;
        continue;
      }
      if (!response.ok || !/text\/html/i.test(response.headers.get("content-type") || "")) return null;
      const text = (await response.text()).slice(0, 300_000);
      return text.length >= 120 ? { url: current.href, text } : null;
    }
    return null;
  } catch (error) {
    console.warn(`[Job scanner] Could not read official HTML for ${normalized}:`, error);
    return null;
  }
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

    const fetched = (await Promise.all(batch.map(async (url) =>
      await fetchReadablePage(url) || await fetchOfficialHtml(url))))
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

/** Retry only transient upstream failures; quota and authentication must not be retried. */
export async function requestGeminiWithRetry<T>(request: () => Promise<T>, delayMs = 600): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const candidate = error as { status?: number; code?: number };
      if (attempt >= 2 || ![502, 503, 504].includes(Number(candidate?.status || candidate?.code))) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
}

async function extractJobs(ai: GoogleGenAI, employerName: string, documents: SourceDocument[]): Promise<ScannedJob[]> {
  if (documents.length === 0) return [];
  const response = await requestGeminiWithRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: buildExtractionPrompt(employerName, documents),
    config: {
      responseMimeType: "application/json",
      responseSchema: extractionSchema,
    },
  }));
  return parseEvidenceBackedJobs(response.text || "", documents);
}

async function discoverCandidateUrls(ai: GoogleGenAI, employerName: string, website: string): Promise<string[]> {
  const response: any = await requestGeminiWithRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: `Find official, currently open job-detail or job-search pages for "${employerName}" in Greater Philadelphia. The employer website is ${website}. Focus on the employer's site and its official applicant-tracking system. Do not use job-description aggregators or old cached postings.`,
    config: { tools: [{ googleSearch: {} }] },
  }));

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
  const officialUrl = LEGACY_CAREER_URLS.get(comparableUrl(targetUrl)) || targetUrl;
  if (employerName.trim().toLowerCase() === "bank of america" &&
      new URL(officialUrl).hostname.toLowerCase() === "careers.bankofamerica.com") {
    const bankJobs = await fetchBankOfAmericaJobs();
    if (bankJobs.length > 0) return { jobs: bankJobs, source: "official-page", authoritative: true };
  }
  if (employerName.trim().toLowerCase() === "santander" &&
      ["jobs.santanderbank.com", "www.santandercareers.com"].includes(new URL(officialUrl).hostname.toLowerCase())) {
    const santanderJobs = await fetchSantanderJobs();
    if (santanderJobs.length > 0) return { jobs: santanderJobs, source: "official-page", authoritative: true };
  }
  if (employerName.trim().toLowerCase() === "septa" && new URL(officialUrl).hostname === "jobs.septa.org") {
    const septaJobs = await fetchSeptaJobs();
    if (septaJobs.length > 0) return { jobs: septaJobs, source: "official-page", authoritative: true };
  }
  if (employerName.trim().toLowerCase() === "phmc" &&
      ["phmc.org", "www.phmc.org"].includes(new URL(officialUrl).hostname.toLowerCase())) {
    const phmcJobs = await fetchUkgJobs(PHMC_BOARD);
    if (phmcJobs.length > 0) return { jobs: phmcJobs, source: "official-page", authoritative: true };
  }
  const directDocument = await fetchOfficialHtml(officialUrl);
  if (directDocument) {
    if (employerName.trim().toLowerCase() === "center city district" &&
        new URL(directDocument.url).hostname === "centercityphila.org") {
      const centerCityJobs = parseCenterCityJobs(directDocument.text);
      if (centerCityJobs.length > 0) {
        return { jobs: centerCityJobs, source: "official-page", authoritative: true };
      }
    }
    if (employerName.trim().toLowerCase() === "newman paperboard" &&
        new URL(directDocument.url).hostname === "newmanpaperboard.com") {
      const newmanJobs = await fetchNewmanJobs(directDocument);
      if (newmanJobs.length > 0) return { jobs: newmanJobs, source: "official-page", authoritative: true };
    }
    const directJobs = await extractStructuredAtsJobs([directDocument]);
    if (directJobs.length > 0) {
      return { jobs: directJobs, source: "official-page", authoritative: true };
    }
  }
  const officialDocument = await fetchReadablePage(officialUrl);
  let documents: SourceDocument[] = directDocument ? [directDocument] : [];
  if (officialDocument) {
    try {
      documents = await collectCareerDocuments(officialDocument);
      if (directDocument) documents.push(directDocument);
      const structuredJobs = await extractStructuredAtsJobs(documents);
      if (structuredJobs.length > 0) {
        return { jobs: structuredJobs, source: "official-page", authoritative: true };
      }
    } catch (error) {
      console.warn(`[Job scanner] Official-source discovery failed for ${employerName}:`, error);
    }
  } else if (directDocument) {
    documents = await collectCareerDocuments(directDocument);
    const structuredJobs = await extractStructuredAtsJobs(documents);
    if (structuredJobs.length > 0) {
      return { jobs: structuredJobs, source: "official-page", authoritative: true };
    }
  }

  const ai = getAIClient();
  if (!ai) {
    return { jobs: [], source: "no-jobs-found", authoritative: false,
      error: "GEMINI_API_KEY is missing or invalid in the server environment." };
  }
  if (documents.length > 0) {
    try {
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
      const candidateUrls = await discoverCandidateUrls(ai, employerName, officialUrl);
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
    lastWarning = documents.length > 0
      ? "Could not verify open regional positions from the available official pages. Paid search fallback is disabled; this does not mean the employer has no openings."
      : "Could not read the employer's official careers page. Check its website URL; the scan was not verified.";
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
    authoritative: false,
    warning: lastWarning,
  };
}
