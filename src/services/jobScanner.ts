export interface ScannedJob {
  title: string;
  location?: string;
  city?: string;
  roleType?: string;
  url?: string;
  postedDate?: string;
  description?: string;
}

export interface JobScanResult {
  jobs: ScannedJob[];
  source: string;
  authoritative: boolean;
  warning?: string;
}

/** An unavailable source is not proof that an employer has zero openings. */
export function isVerifiedScanResult(result: JobScanResult): boolean {
  return result.jobs.length > 0 || result.authoritative;
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
): Promise<JobScanResult> {
  if (!websiteUrl || !websiteUrl.startsWith("http")) {
    throw new Error(`Invalid website URL for ${employerName}.`);
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

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || `Backend scan failed (${response.status}).`);
    }

    return {
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
      source: String(data.source || "unknown"),
      authoritative: Boolean(data.authoritative),
      warning: data.warning ? String(data.warning) : undefined,
    };

  } catch (error) {
    console.error(`[JobScanner] Failed scanning ${employerName}:`, error);
    throw error;
  }
}
