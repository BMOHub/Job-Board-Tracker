import { GoogleGenAI, Type } from "@google/genai";

const getApiKey = () => {
  let key = "";
  
  // 1. Try process.env (Vite 'define' or Node environment)
  try {
    if (typeof process !== 'undefined' && (process as any).env) {
      key = (process as any).env.GEMINI_API_KEY;
    }
  } catch (e) {
    // Ignore error
  }

  // 2. If not found or placeholder, try import.meta.env (Vite standard)
  if (!key || key === "MY_GEMINI_API_KEY") {
    try {
      key = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    } catch (e) {
      // Ignore error
    }
  }

  // 3. Last fallback: global window variable (if injected)
  if (!key || key === "MY_VITE_GEMINI_API_KEY") {
    try {
      key = (window as any).GEMINI_API_KEY || "";
    } catch (e) {
      // Ignore error
    }
  }

  return key || "";
};

let aiInstance: GoogleGenAI | null = null;

const getAI = () => {
  if (!aiInstance) {
    const key = getApiKey();
    if (key) {
      aiInstance = new GoogleGenAI({ apiKey: key });
    }
  }
  return aiInstance;
};

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
  const ai = getAI();
  if (!ai) {
    throw new Error("Gemini API Key is not configured. Please check your environment variables (GEMINI_API_KEY or VITE_GEMINI_API_KEY).");
  }

  const today = new Date().toISOString().split('T')[0];
  const prompt = `Find current job openings at ${employerName}.
  - LOCATION: Greater Philadelphia area (Philly, SE Pennsylvania, or South Jersey).
  - RECENCY: Focus on jobs posted in the last 2-3 weeks.
  - LINKS: You MUST provide the specific, direct URL to each individual job posting. Avoid the general careers home page.
  - WEBSITE FOR REFERENCE: ${website}
  
  Return the results as a JSON array of objects.
  Each object MUST have: title, url (direct link), location, city, roleType (Full-time, Part-time, Contract, or Internship), postedDate (YYYY-MM-DD), and a brief description.
  
  If you find no relevant jobs in the Philadelphia area, return an empty array [].`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
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

    if (response && response.text) {
      try {
        return JSON.parse(response.text);
      } catch (parseError) {
        console.error("Failed to parse Gemini JSON response:", response.text, parseError);
        return [];
      }
    }
    console.warn(`No response text from Gemini for ${employerName}`);
    return [];
  } catch (error: any) {
    console.error(`Error scanning jobs for ${employerName}:`, error);
    // Rethrow to allow the UI to catch and display specific error
    throw error;
  }
}
