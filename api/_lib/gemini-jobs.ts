import { GoogleGenAI } from "@google/genai";

export interface ScannedJob {
  title: string;
  url: string;
  location: string;
  city: string;
  roleType: string;
  postedDate: string;
  description: string;
}

const getAI = () => {
  const key = process.env.GEMINI_API_KEY || "";
  return key ? new GoogleGenAI({ apiKey: key }) : null;
};

// Aggressive JSON parser that strips away markdown formatting
function cleanAndParseJSON(text: string, baseUrl: string): ScannedJob[] {
  if (!text) return [];
  
  let cleanText = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed: any = null;
  
  try {
    parsed = JSON.parse(cleanText);
  } catch (e) {
    const start = cleanText.indexOf("[");
    const end = cleanText.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(cleanText.substring(start, end + 1));
      } catch (err) {}
    }
  }

  const jobs = Array.isArray(parsed) ? parsed : (parsed?.jobs || []);
  const today = new Date().toISOString().split("T")[0];

  return jobs.map((j: any) => {
    let url = String(j.url || baseUrl).trim();
    if (!url.startsWith("http") && !url.startsWith("mailto:")) {
      try { 
        url = new URL(url, baseUrl).href; 
      } catch(e) { 
        url = baseUrl; 
      }
    }
    return {
      title: String(j.title || "Unknown Title").trim(),
      url: url,
      location: String(j.location || "Philadelphia, PA").trim(),
      city: String(j.city || "Philadelphia").trim(),
      roleType: String(j.roleType || "Full-time").trim(),
      postedDate: String(j.postedDate || today).trim(),
      description: String(j.description || "").trim()
    };
  }).filter((j: any) => j.title !== "Unknown Title");
}

export async function scanJobsForEmployer(employerName: string, website: string, existingTitles: string[]) {
  const ai = getAI();
  if (!ai) return { error: "GEMINI_API_KEY not configured on Vercel." };

  const targetUrl = website.startsWith("http") ? website : `https://${website}`;
  let pageText = "";
  
  // 1. Auto-generate the correct career links if the user only provided the homepage
  const candidateUrls = [
    targetUrl,
    `${new URL(targetUrl).origin}/join-our-team`,
    `${new URL(targetUrl).origin}/careers`
  ];

  // 2. Fetch live text from the website
  for (const url of candidateUrls) {
    try {
      const res = await fetch(`[https://r.jina.ai/$](https://r.jina.ai/$){url}`, { headers: { "Accept": "text/plain" }});
      if (res.ok) {
        const text = await res.text();
        if (text.length > 200 && !text.includes("404 Not Found")) {
          pageText = text.slice(0, 15000);
          break; // Stop looking once we successfully grab the page text
        }
      }
    } catch(e) {}
  }

  // 3. Extract the jobs using Gemini
  if (pageText) {
    const prompt = `Extract all active job openings for "${employerName}" from this webpage text.
Return ONLY a JSON array.

Website: ${targetUrl}

Text:
${pageText}

Format EXACTLY like this:
[
  {
    "title": "Job Title",
    "url": "Application URL (use exact link if present, otherwise ${targetUrl})",
    "location": "Philadelphia, PA",
    "city": "Philadelphia",
    "roleType": "Full-time",
    "postedDate": "2026-09-22",
    "description": "Short description"
  }
]`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt
      });
      if (response?.text) {
        const jobs = cleanAndParseJSON(response.text, targetUrl);
        if (jobs.length > 0) return { jobs, source: "live-scrape" };
      }
    } catch (e) {
      console.error("Gemini text extraction failed:", e);
    }
  }

  // 4. Google Search Fallback (if the website blocks the scraper)
  try {
    const searchPrompt = `Search Google for active job openings at "${employerName}" in Philadelphia PA. List all positions found. Return ONLY a JSON array formatted exactly as above.`;
    const searchRes: any = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: searchPrompt,
      config: { tools: [{ googleSearch: {} }] }
    });
    if (searchRes?.text) {
      const jobs = cleanAndParseJSON(searchRes.text, targetUrl);
      if (jobs.length > 0) return { jobs, source: "google-search" };
    }
  } catch (e) {
    console.error("Gemini search fallback failed:", e);
  }

  return { jobs: [], source: "no-jobs-found" };
}
