import type { YCDirectoryResult } from '../types';

const YC_API_URL = 'https://yc-oss.github.io/api/companies/all.json';

// In-memory cache per cron run (CLAUDE.md: cache it, do not re-fetch)
let cachedCompanies: YCCompanyEntry[] | null = null;

interface YCCompanyEntry {
  id: number;
  name: string;
  slug: string;
  batch: string;
  one_liner: string;
  long_description: string;
  team_size: number;
  website: string;
  stage: string;
  isHiring: boolean;
  all_locations: string;
  [key: string]: unknown;
}

export async function loadYCDirectory(): Promise<YCCompanyEntry[]> {
  if (cachedCompanies) return cachedCompanies;

  const res = await fetch(YC_API_URL);
  if (!res.ok) throw new Error(`YC directory fetch failed: ${res.status}`);
  cachedCompanies = (await res.json()) as YCCompanyEntry[];
  console.log(`Loaded ${cachedCompanies.length} companies from YC directory`);
  return cachedCompanies;
}

export function clearYCDirectoryCache(): void {
  cachedCompanies = null;
}

/**
 * Fuzzy-match a company name against the YC directory.
 * Uses normalised Levenshtein similarity with threshold 0.85.
 *
 * Note: The YC OSS API does not include founder names.
 * Founders are populated as empty; the synthesis step will
 * infer founder info from other sources (press, HN, blog).
 */
export async function lookupYCDirectory(
  companyName: string
): Promise<YCDirectoryResult | null> {
  const companies = await loadYCDirectory();
  const normTarget = normalise(companyName);

  let bestMatch: YCCompanyEntry | null = null;
  let bestSimilarity = 0;

  for (const co of companies) {
    const normName = normalise(co.name);
    const sim = similarity(normTarget, normName);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = co;
    }
    if (sim === 1) break;
  }

  if (!bestMatch || bestSimilarity < 0.85) {
    return null;
  }

  return {
    batch: bestMatch.batch || '',
    founders: [], // Not available from YC OSS API
    one_liner: bestMatch.one_liner || '',
    team_size: bestMatch.team_size || 0,
    website: bestMatch.website || '',
  };
}

// ── String helpers ──

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
