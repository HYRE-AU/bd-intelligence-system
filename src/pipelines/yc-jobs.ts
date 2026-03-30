import { chromium, type Page } from 'playwright';
import { SALES_KEYWORDS } from '../config/keywords';
import {
  jobIdExists,
  insertJobListings,
  insertDedupLog,
} from '../db/supabase';
import type { YCJobListing } from '../types';

// ── URLs to scrape ──
// Scraped in order. Jobs on each page are rendered newest-first.

const YC_JOBS_URLS = [
  'https://www.ycombinator.com/jobs',
  'https://www.ycombinator.com/jobs/role/sales-manager/san-francisco',
  'https://www.ycombinator.com/jobs/role/all',
];

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

/**
 * Scrape job listings from a YC jobs page.
 *
 * DOM structure (verified 2026-03-30):
 *   ul.space-y-2 > li  (one per job, newest first)
 *     li contains:
 *       a[href="/companies/SLUG"]            — company link
 *       span.font-bold                       — "Company (BATCH)"
 *       a[href="/companies/SLUG/jobs/ID-*"]  — role title link (class text-linkColor)
 *       span.text-gray-400                   — "(3 days ago)"
 */
async function scrapeJobsFromPage(page: Page, url: string): Promise<RawJob[]> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page
    .waitForSelector('ul.space-y-2 > li', { timeout: 15_000 })
    .catch(() => null);

  const extractJobs = new Function(`
    const jobs = [];
    const cards = document.querySelectorAll('ul.space-y-2 > li');

    for (const card of cards) {
      const roleLink = card.querySelector('a[href*="/companies/"][href*="/jobs/"]');
      if (!roleLink) continue;

      const roleTitle = roleLink.textContent.trim();
      const roleHref = roleLink.getAttribute('href') || '';
      const fullRoleUrl = 'https://www.ycombinator.com' + roleHref;

      const jobIdMatch = roleHref.match(/\\/jobs\\/([^-]+)/);
      const jobId = jobIdMatch ? jobIdMatch[1] : roleHref;

      const nameSpan = card.querySelector('span.font-bold');
      const nameText = nameSpan ? nameSpan.textContent.trim() : '';
      const batchMatch = nameText.match(/\\(([WS]\\d{2})\\)/);
      const batch = batchMatch ? batchMatch[1] : '';
      const companyName = nameText.replace(/\\s*\\([WS]\\d{2}\\)/, '').trim();

      const companyLink = card.querySelector('a[href*="/companies/"]:not([href*="/jobs/"])');
      const companyHref = companyLink ? companyLink.getAttribute('href') : '';
      const companyUrl = companyHref ? 'https://www.ycombinator.com' + companyHref : '';

      const postedSpan = card.querySelector('span.text-gray-400, [class*="text-gray-400"]');
      const postedText = postedSpan ? postedSpan.textContent.replace(/[()]/g, '').trim() : '';

      if (roleTitle) {
        jobs.push({
          jobId: jobId,
          companyName: companyName,
          companyBatch: batch,
          companyUrl: companyUrl,
          roleTitle: roleTitle,
          roleUrl: fullRoleUrl,
          postedAt: postedText || new Date().toISOString(),
        });
      }
    }

    return jobs;
  `) as () => RawJob[];

  return page.evaluate(extractJobs);
}

export async function scrapeYCJobs(): Promise<RawJob[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const allJobs = new Map<string, RawJob>();

  try {
    const page = await context.newPage();

    for (const url of YC_JOBS_URLS) {
      console.log(`Scraping ${url}...`);
      try {
        const jobs = await scrapeJobsFromPage(page, url);
        for (const job of jobs) {
          if (!allJobs.has(job.jobId)) {
            allJobs.set(job.jobId, job);
          }
        }
        // 1-2s random delay between pages
        await page.waitForTimeout(1000 + Math.random() * 1000);
      } catch (err) {
        console.error(`Failed to scrape ${url}:`, err);
      }
    }
  } finally {
    await browser.close();
  }

  return Array.from(allJobs.values());
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
    // Skip duplicates within this scrape (same job across multiple URLs)
    if (seenJobIds.has(job.jobId)) continue;
    seenJobIds.add(job.jobId);

    // Check Supabase for this job_id
    const exists = await jobIdExists(job.jobId);

    if (exists) {
      // We've reached previously processed jobs — stop checking further
      if (!hitExisting) {
        console.log(
          `Hit existing job_id ${job.jobId} ("${job.roleTitle}") — stopping incremental scan`
        );
      }
      hitExisting = true;
      continue;
    }

    // New job — run keyword matching
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

    // Log all new jobs to dedup_log
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

    // Show first 10 scraped jobs
    for (const job of rawJobs.slice(0, 10)) {
      console.log(`  [${job.companyBatch || '??'}] ${job.companyName} — ${job.roleTitle}`);
      console.log(`       ${job.roleUrl}`);
    }
    if (rawJobs.length > 10) {
      console.log(`  ... and ${rawJobs.length - 10} more\n`);
    }

    // Run keyword matching
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
