import { GoogleGenAI, Type } from "@google/genai";

const getApiKey = () => {
  try {
    // Check VITE_ prefix first (standard for Vite client-side)
    const vKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    if (vKey) return vKey;

    // Fallback to process.env (common for AI Studio or defined via vite.config.ts)
    // Note: Vite's define replaces literal string process.env.GEMINI_API_KEY
    const pKey = typeof process !== 'undefined' ? (process as any).env?.GEMINI_API_KEY : undefined;
    if (pKey) return pKey;
    
    // Some build systems inject it directly into a global
    return (window as any).GEMINI_API_KEY || "";
  } catch {
    return "";
  }
};

const ai = new GoogleGenAI({ apiKey: getApiKey() });

export const isGeminiConfigured = () => !!getApiKey();

export interface ScannedJob {
  title: string;
  url: string;
  location: string;
  city: string;
  roleType: string;
  postedDate: string;
  description: string;
}

export async function scanJobsForEmployer(employerName: string, website: string): Promise<ScannedJob[]> {
  const today = new Date().toISOString().split('T')[0];
  const prompt = `Today's date is ${today}. Find the latest job postings for "${employerName}" that meet the following criteria:
  1. LOCATION: Must be in the Greater Philadelphia region (including Philadelphia, Bucks, Chester, Delaware, and Montgomery counties in PA, or Burlington, Camden, and Gloucester counties in NJ).
  2. RECENCY: Must have been posted within the last 15 days (since ${new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}).
  3. LINKS (CRITICAL): Provide the UNIQUE, DIRECT URL to each specific job description page. 
     - DO NOT provide the same URL for multiple jobs.
     - DO NOT provide generic career portal search pages (e.g., ending in /jobs or /careers without a specific ID).
     - The URL MUST lead directly to the full job description for that specific title.
  4. DATA INTEGRITY: The title and description MUST be specific to the job linked. If you cannot find a direct link for a specific job, do not include it.
  5. SOURCE: Use the official employer website if possible: ${website}.
  
  Return a list of jobs with their title, direct URL, specific city, role type (e.g., Full-time, Part-time, Contract, Internship), and approximate posted date in YYYY-MM-DD format. 
  If no jobs matching these criteria are found, return an empty array.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        toolConfig: { includeServerSideToolInvocations: true },
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

    if (response.text) {
      return JSON.parse(response.text);
    }
    return [];
  } catch (error) {
    console.error(`Error scanning jobs for ${employerName}:`, error);
    return [];
  }
}
