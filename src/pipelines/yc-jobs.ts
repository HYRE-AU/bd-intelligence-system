import { SALES_KEYWORDS } from '../config/keywords';
import {
  jobIdExists,
  insertJobListings,
  insertDedupLog,
} from '../db/supabase';
import type { YCJobListing } from '../types';

// ── URLs to scrape ──

const YC_JOBS_URL = 'https://www.ycombinator.com/jobs';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Keyword matching ──

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

/**
 * Exact substring match first, then Levenshtein fallback (distance <= 2)
 * on multi-word keyword phrases only (short keywords like "AE", "SDR"
 * require exact word-boundary match to avoid false positives).
 */
export function matchKeywords(title: string): string | null {
  const norm = normalise(title);

  // Pass 1: exact substring
  for (const [group, keywords] of Object.entries(SALES_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = normalise(kw);
      if (kwNorm.length <= 4) {
        const wordPattern = new RegExp(`\\b${kwNorm}\\b`);
        if (wordPattern.test(norm)) {
          return `${group}:${kw}`;
        }
      } else {
        if (norm.includes(kwNorm)) {
          return `${group}:${kw}`;
        }
      }
    }
  }

  // Pass 2: Levenshtein fuzzy match — only for keywords >= 12 chars
  for (const [group, keywords] of Object.entries(SALES_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = normalise(kw);
      if (kwNorm.length < 12) continue;
      if (fuzzyMatch(norm, kwNorm, 2)) {
        return `${group}:${kw}`;
      }
    }
  }

  return null;
}

function fuzzyMatch(text: string, keyword: string, maxDist: number): boolean {
  const kLen = keyword.length;
  if (kLen === 0) return false;
  for (let i = 0; i <= text.length - kLen; i++) {
    const window = text.slice(i, i + kLen);
    if (levenshtein(window, keyword) <= maxDist) {
      return true;
    }
  }
  return false;
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

// ── Scraper ──

interface RawJob {
  jobId: string;
  companyName: string;
  companyBatch: string;
  companyUrl: string;
  roleTitle: string;
  roleUrl: string;
  postedAt: string;
}

/** Shape of each job object embedded in the YC jobs page HTML. */
interface YCEmbeddedJob {
  id: number;
  title: string;
  url: string;
  companyName: string;
  companyBatchName: string | null;
  companyUrl: string;
  lastActive: string;
  prettyRole: string;
  [key: string]: unknown;
}

/**
 * Extract the embedded JSON job listings from a YC jobs page.
 *
 * The YC /jobs page embeds structured job data as HTML-entity-encoded
 * JSON in the page source (no JS execution needed).
 */
function extractJobsFromHtml(html: string): RawJob[] {
  // Find the HTML-entity-encoded JSON array: [{&quot;id&quot;:...}]
  const marker = '[{&quot;id&quot;';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];

  // Decode HTML entities
  const decoded = html
    .slice(idx)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u0026/g, '&');

  // Find the matching closing bracket
  let depth = 0;
  let end = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] === '[') depth++;
    if (decoded[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end === 0) return [];

  let jobs: YCEmbeddedJob[];
  try {
    jobs = JSON.parse(decoded.slice(0, end));
  } catch {
    console.error('Failed to parse embedded YC jobs JSON');
    return [];
  }

  return jobs.map((j) => ({
    jobId: String(j.id),
    companyName: j.companyName || '',
    companyBatch: j.companyBatchName || '',
    companyUrl: j.companyUrl
      ? `https://www.ycombinator.com${j.companyUrl}`
      : '',
    roleTitle: j.title || '',
    roleUrl: j.url
      ? `https://www.ycombinator.com${j.url}`
      : '',
    postedAt: j.lastActive || '',
  }));
}

/**
 * Scrape YC job listings using fetch + HTML parsing.
 * Extracts structured JSON embedded in the page source.
 */
export async function scrapeYCJobs(): Promise<RawJob[]> {
  console.log(`Fetching ${YC_JOBS_URL}...`);

  const res = await fetch(YC_JOBS_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    console.error(`YC jobs page returned ${res.status}`);
    return [];
  }

  const html = await res.text();
  const jobs = extractJobsFromHtml(html);
  console.log(`Extracted ${jobs.length} jobs from embedded JSON`);

  return jobs;
}

// ── Incremental match + queue ──

/**
 * Scrape YC jobs and incrementally process only new listings.
 *
 * For each scraped job (newest first):
 *   1. Check if job_id already exists in Supabase
 *   2. If it exists → we've reached previously processed jobs, stop
 *   3. If new → run keyword matching, queue for insert
 *
 * On the very first run (empty DB), all jobs are new → full baseline.
 */
export async function queueNewListings(): Promise<YCJobListing[]> {
  const rawJobs = await scrapeYCJobs();
  console.log(`Scraped ${rawJobs.length} total jobs`);

  const matched: YCJobListing[] = [];
  const seenJobIds = new Set<string>();
  let newCount = 0;
  let hitExisting = false;

  for (const job of rawJobs) {
    if (seenJobIds.has(job.jobId)) continue;
    seenJobIds.add(job.jobId);

    const exists = await jobIdExists(job.jobId);

    if (exists) {
      if (!hitExisting) {
        console.log(
          `Hit existing job_id ${job.jobId} ("${job.roleTitle}") — stopping incremental scan`
        );
      }
      hitExisting = true;
      continue;
    }

    newCount++;
    const keyword = matchKeywords(job.roleTitle);
    if (!keyword) continue;

    matched.push({
      job_id: job.jobId,
      company_name: job.companyName,
      company_batch: job.companyBatch,
      company_url: job.companyUrl,
      role_title: job.roleTitle,
      role_url: job.roleUrl,
      matched_keyword: keyword,
      posted_at: job.postedAt,
    });
  }

  console.log(
    `${newCount} new jobs found${hitExisting ? ' (incremental)' : ' (first run — full baseline)'}`
  );

  if (matched.length > 0) {
    const now = new Date().toISOString();
    await insertJobListings(
      matched.map((m) => ({
        ...m,
        first_seen_at: now,
      }))
    );

    for (const m of matched) {
      await insertDedupLog('yc_jobs', m.job_id);
    }

    console.log(`Inserted ${matched.length} new matched listings`);
  } else {
    console.log('No new matched listings');
  }

  return matched;
}

// ── Local test mode ──
// Run with: npx ts-node src/pipelines/yc-jobs.ts

if (require.main === module) {
  (async () => {
    console.log('\n=== YC Jobs Scraper — Local Test ===\n');

    const rawJobs = await scrapeYCJobs();
    console.log(`\nScraped ${rawJobs.length} total jobs from YC\n`);

    for (const job of rawJobs.slice(0, 10)) {
      console.log(`  [${job.companyBatch || '??'}] ${job.companyName} — ${job.roleTitle}`);
      console.log(`       ${job.roleUrl}`);
    }
    if (rawJobs.length > 10) {
      console.log(`  ... and ${rawJobs.length - 10} more\n`);
    }

    console.log('\n--- Keyword Matches ---\n');
    let matchCount = 0;
    for (const job of rawJobs) {
      const keyword = matchKeywords(job.roleTitle);
      if (keyword) {
        matchCount++;
        console.log(`  ✓ ${job.companyName} (${job.companyBatch || '??'}) — ${job.roleTitle}`);
        console.log(`    Matched: ${keyword}`);
        console.log(`    URL: ${job.roleUrl}`);
        console.log();
      }
    }

    console.log(`Total: ${matchCount} matches out of ${rawJobs.length} jobs\n`);
    process.exit(0);
  })().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
