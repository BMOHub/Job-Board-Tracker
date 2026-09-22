export interface ScannedJob {
  title: string;
  location?: string;
  city?: string;
  roleType?: string;
  url?: string;
  postedDate?: string;
  description?: string;
}

/**
 * Checks if the backend Gemini API is configured via Vercel status route.
 */
export async function isGeminiConfigured(): Promise<boolean> {
  try {
    const response = await fetch('/api/gemini-status');
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data.configured);
  } catch (error) {
    console.error('[JobScanner] Failed checking Gemini status:', error);
    return false;
  }
}

/**
 * Scans an employer website by delegating scraping and extraction to /api/scan-jobs.
 */
export async function scanJobsForEmployer(
  employerName: string,
  websiteUrl: string,
  existingTitles: string[] = []
): Promise<ScannedJob[]> {
  if (!websiteUrl || !websiteUrl.startsWith("http")) {
    console.warn(`[JobScanner] Invalid website URL for ${employerName}: ${websiteUrl}`);
    return [];
  }

  try {
    const response = await fetch('/api/scan-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        employerName,
        website: websiteUrl,
        existingTitles
      })
    });

    if (!response.ok) {
      console.warn(`[JobScanner] Backend scan failed for ${employerName} (${response.status})`);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data.jobs) ? data.jobs : (Array.isArray(data) ? data : []);

  } catch (error) {
    console.error(`[JobScanner] Failed scanning ${employerName}:`, error);
    return [];
  }
}
