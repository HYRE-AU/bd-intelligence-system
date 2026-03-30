/**
 * Test Pipeline 1 — YC Sales Job Monitor
 *
 * Scrapes YC jobs board, runs keyword matching, logs matches.
 * No Supabase, no emails.
 *
 * Usage: npx ts-node scripts/test-pipeline-1.ts
 */
import 'dotenv/config';
import { scrapeYCJobs, matchKeywords } from '../src/pipelines/yc-jobs';

(async () => {
  console.log('\n=== Pipeline 1 — YC Sales Job Monitor ===\n');

  const jobs = await scrapeYCJobs();
  console.log(`Scraped ${jobs.length} total jobs from YC\n`);

  // Show all scraped jobs (first 10)
  console.log('--- All Jobs (first 10) ---\n');
  for (const job of jobs.slice(0, 10)) {
    console.log(`  [${job.companyBatch || '??'}] ${job.companyName} — ${job.roleTitle}`);
  }
  if (jobs.length > 10) {
    console.log(`  ... and ${jobs.length - 10} more\n`);
  }

  // Keyword matches
  console.log('\n--- Keyword Matches ---\n');
  let matchCount = 0;
  for (const job of jobs) {
    const keyword = matchKeywords(job.roleTitle);
    if (keyword) {
      matchCount++;
      console.log(`  ✓ ${job.companyName} (${job.companyBatch || '??'}) — ${job.roleTitle}`);
      console.log(`    Matched: ${keyword}`);
      console.log(`    URL: ${job.roleUrl}\n`);
    }
  }

  console.log(`Total: ${matchCount} matches out of ${jobs.length} jobs\n`);
  process.exit(0);
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
