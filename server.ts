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

  const prompt = `Find current job openings at ${employerName}.
  - LOCATION: Greater Philadelphia area (Philly, SE Pennsylvania, or South Jersey).
  - RECENCY: Focus on jobs posted in the last 2-3 weeks.
  - LINKS: You MUST provide the specific, direct URL to each individual job posting. Avoid the general careers home page.
  - WEBSITE FOR REFERENCE: ${website || "No official website provided"}
  
  Return the results as a JSON array of objects.
  Each object MUST have: title, url (direct link), location, city, roleType (Full-time, Part-time, Contract, or Internship), postedDate (YYYY-MM-DD), and a brief description.
  
  If you find no relevant jobs in the Philadelphia area, return an empty array [].`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
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
      try {
        const jobs = JSON.parse(response.text);
        return res.json({ jobs });
      } catch (parseError: any) {
        console.error("Failed to parse Gemini JSON response:", response.text, parseError);
        return res.json({ jobs: [], warning: "Could not parse Gemini JSON response", rawText: response.text });
      }
    }

    console.warn(`No response text from Gemini for ${employerName}`);
    return res.json({ jobs: [] });
  } catch (error: any) {
    console.error(`Error scanning jobs for ${employerName}:`, error);
    return res.status(500).json({ error: error.message || "An error occurred during Gemini scanning." });
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
