export interface ScannedJob {
  title: string;
  url: string;
  location: string;
  city: string;
  roleType: string;
  postedDate: string;
  description: string;
}

// Check if Gemini is configured. This can be checked client-side initially via Vite define or process.env,
// but our React App will also dynamically check the backend /api/gemini-status endpoint for live settings.
export const isGeminiConfigured = () => {
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

  return !!key && key !== "MY_GEMINI_API_KEY" && key !== "MY_VITE_GEMINI_API_KEY";
};

export async function scanJobsForEmployer(employerName: string, website: string): Promise<ScannedJob[]> {
  const response = await fetch("/api/scan-jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ employerName, website }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Scan failed for ${employerName}. Server returned status ${response.status}.`);
  }

  const data = await response.json();
  return data.jobs || [];
}
