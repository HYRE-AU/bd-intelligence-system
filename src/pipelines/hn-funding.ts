import { lookupYCDirectory } from '../research/yc-directory';
import { crawlCareersPage } from '../research/careers-crawler';
import { searchPressRSS } from '../research/press-rss';
import { extractHNThread } from '../research/hn-thread';
import { crawlBlog } from '../research/blog-crawler';
import { synthesiseIntelCard } from '../research/synthesise';
import {
  storyIdExists,
  insertDedupLog,
  isDoNotContact,
  insertIntelCard,
} from '../db/supabase';
import { sendIntelCardEmail } from '../email/intel-card';
import type { IntelCard, ResearchData, YCDirectoryResult } from '../types';

// ── HN Algolia search terms (used to cast a wide net, then filtered) ──

const SEARCH_TERMS = [
  'raises',
  'funding',
  'seed round',
  'Series A',
  'Series B',
  'Launch HN',
  'Show HN',
  'just raised',
  'announces',
];

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';

// ── Title blocklist — skip immediately if title contains any of these ──

const TITLE_BLOCKLIST = [
  'stole', 'froze', 'closed', 'scam', 'fraud', 'lawsuit',
  'complaint', 'warning', 'bad', 'terrible', 'awful', 'broke',
  'withheld', 'sued', 'stolen', 'hacked', 'breach', 'leak',
];

// ── Title allowlist — must contain at least one of these to proceed ──

const TITLE_ALLOWLIST = [
  'raises $',
  'raised $',
  'launch hn:',
  'show hn:',
  'announces $',
  'seed round',
  'series a',
  'series b',
  'funding round',
  'pre-seed',
];

/**
 * Check if a story title passes both the blocklist and allowlist.
 * Returns false if ANY blocklist word is found.
 * Returns true only if at least ONE allowlist phrase is found.
 */
function isFundingSignal(title: string): boolean {
  const lower = title.toLowerCase();

  // Blocklist: reject immediately
  for (const blocked of TITLE_BLOCKLIST) {
    if (lower.includes(blocked)) return false;
  }

  // Allowlist: must match at least one
  for (const allowed of TITLE_ALLOWLIST) {
    if (lower.includes(allowed)) return true;
  }

  return false;
}

interface HNStory {
  objectID: string;
  title: string;
  url: string | null;
  author: string;
  points: number;
  created_at: string;
  num_comments: number;
}

interface HNSearchResponse {
  hits: HNStory[];
}

/**
 * Poll HN Algolia API for funding/launch stories.
 * Filter: stories only, points > 5, created in last 2 hours.
 * Applies blocklist/allowlist filtering before returning.
 */
async function pollHNFunding(): Promise<HNStory[]> {
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
  const allStories = new Map<string, HNStory>();

  for (const term of SEARCH_TERMS) {
    try {
      const params = new URLSearchParams({
        query: term,
        tags: 'story',
        numericFilters: `created_at_i>${twoHoursAgo},points>5`,
      });
      const res = await fetch(`${HN_SEARCH_URL}?${params}`);
      if (!res.ok) continue;

      const data = (await res.json()) as HNSearchResponse;
      for (const hit of data.hits) {
        if (!allStories.has(hit.objectID)) {
          allStories.set(hit.objectID, hit);
        }
      }
    } catch (err) {
      console.error(`HN search failed for "${term}":`, err);
    }
  }

  // Apply title filter right here — nothing passes without it
  const raw = Array.from(allStories.values());
  const filtered = raw.filter((s) => isFundingSignal(s.title));
  if (raw.length !== filtered.length) {
    console.log(
      `Title filter: ${raw.length} raw → ${filtered.length} passed (${raw.length - filtered.length} blocked)`
    );
  }

  return filtered;
}

/**
 * Extract company name from HN story title.
 * Handles patterns like "Company raises $XM", "Show HN: Company – tagline", etc.
 */
function extractCompanyName(title: string): string {
  // "Show HN: Company – tagline" or "Launch HN: Company – tagline"
  const showHNMatch = title.match(/(?:Show|Launch)\s+HN:\s*([^–—\-|]+)/i);
  if (showHNMatch) return showHNMatch[1].trim();

  // "Company raises/raised $XM" or "Company announces..."
  const raisesMatch = title.match(
    /^([^(]+?)\s+(?:raises?|raised|announces?|secures?|closes?|gets?)/i
  );
  if (raisesMatch) return raisesMatch[1].trim();

  // "YC Company (YC W26) ..." — strip batch
  const ycMatch = title.match(/^(.+?)\s*\(YC\s+[WS]\d{2}\)/i);
  if (ycMatch) return ycMatch[1].trim();

  // Fallback: first segment before common delimiters
  const fallback = title.split(/[–—\-|:]/)[0].trim();
  return fallback;
}

/**
 * Run the research agent for a CONFIRMED YC company.
 *
 * The YC directory result is passed in (already looked up by the caller).
 * Remaining steps run in parallel via Promise.allSettled.
 * Failed steps return null; synthesis proceeds with available data.
 */
export async function runResearchAgent(
  companyName: string,
  companyUrl: string,
  storyId: string,
  storyAuthor: string,
  ycDirectoryResult?: YCDirectoryResult | null
): Promise<ResearchData> {
  // Use provided YC result, or look up fresh (for Pipeline 3 reuse)
  let ycDirectory = ycDirectoryResult ?? null;
  if (ycDirectory === undefined) {
    try {
      ycDirectory = await lookupYCDirectory(companyName);
    } catch (err) {
      console.error('YC directory lookup failed:', err);
    }
  }

  // Resolve company URL: prefer YC directory website, then caller-provided URL
  const resolvedUrl = ycDirectory?.website || companyUrl;

  // Run remaining steps in parallel
  const [careersResult, pressResult, hnResult, blogResult] =
    await Promise.allSettled([
      resolvedUrl ? crawlCareersPage(resolvedUrl) : Promise.resolve(null),
      searchPressRSS(companyName),
      extractHNThread(storyId, storyAuthor),
      resolvedUrl ? crawlBlog(resolvedUrl) : Promise.resolve(null),
    ]);

  return {
    ycDirectory,
    careers: careersResult.status === 'fulfilled' ? careersResult.value : null,
    press: pressResult.status === 'fulfilled' ? pressResult.value : [],
    hnThread: hnResult.status === 'fulfilled' ? hnResult.value : null,
    blog: blogResult.status === 'fulfilled' ? blogResult.value : null,
  };
}

/**
 * Pipeline 2 main entry: poll HN, research new signals, send intel cards.
 *
 * Three gates before the research agent fires:
 *   1. Title passes blocklist/allowlist (applied inside pollHNFunding)
 *   2. Company must exist in YC directory — if not, skip entirely
 *   3. Company must not be on the do-not-contact list
 */
export async function runHNFundingPipeline(
  options: { dryRun?: boolean } = {}
): Promise<IntelCard[]> {
  const { dryRun = false } = options;
  if (dryRun) {
    console.log('Pipeline 2 [DRY RUN]: no Supabase writes, no emails\n');
  }

  console.log('Pipeline 2: Polling HN for funding signals...');
  const stories = await pollHNFunding();
  console.log(`${stories.length} stories passed title filter`);

  const cards: IntelCard[] = [];

  for (const story of stories) {
    try {
      // Dedup check (skip in dry run — no DB)
      if (!dryRun) {
        const exists = await storyIdExists(story.objectID);
        if (exists) {
          await insertDedupLog('hn_funding', story.objectID);
          continue;
        }
      }

      const companyName = extractCompanyName(story.title);
      console.log(`\nProcessing: "${story.title}" → company: "${companyName}"`);

      // GATE: YC directory lookup — must be a YC company
      const ycLookup = await lookupYCDirectory(companyName);
      if (!ycLookup) {
        console.log(`  Skipping — not a YC company (not found in YC directory)`);
        if (!dryRun) await insertDedupLog('hn_funding', story.objectID);
        continue;
      }
      console.log(`  ✓ YC company confirmed: ${ycLookup.batch} | ${ycLookup.one_liner}`);

      // GATE: DNC check (skip in dry run — no DB)
      if (!dryRun) {
        const dnc = await isDoNotContact(companyName);
        if (dnc) {
          console.log(`  Skipping ${companyName} — do not contact`);
          await insertDedupLog('dnc_skip', story.objectID);
          continue;
        }
      }

      // Both gates passed — run research agent with the YC result we already have
      const companyUrl = story.url || '';
      const research = await runResearchAgent(
        companyName,
        companyUrl,
        story.objectID,
        story.author,
        ycLookup
      );

      const resolvedUrl = research.ycDirectory?.website || companyUrl;

      // Synthesise intel card (requires OPENAI_API_KEY)
      if (!process.env.OPENAI_API_KEY) {
        console.log(`  ⚠ Skipping synthesis — no OPENAI_API_KEY`);
        continue;
      }

      const card = await synthesiseIntelCard(research, {
        hn_story_id: story.objectID,
        hn_comment_id: null,
        pipeline: 'funding',
        company_name: companyName,
        company_url: resolvedUrl,
        raw_hn_comment: null,
        do_not_contact: false,
      });

      if (!dryRun) {
        await insertIntelCard(card as unknown as Record<string, unknown>);
        await insertDedupLog('hn_funding', story.objectID);
        await sendIntelCardEmail(card);
      }

      cards.push(card);
      console.log(
        `  ✓ Intel card generated: ${companyName} — score ${card.opportunity_score}/10`
      );
    } catch (err) {
      console.error(`Failed to process story ${story.objectID}:`, err);
    }
  }

  return cards;
}

// ── Local test mode ──
// Run with: npx ts-node src/pipelines/hn-funding.ts
//
// Runs the research agent on a single HN story and prints the intel card.
// Does NOT send email or write to Supabase.

if (require.main === module) {
  (async () => {
    console.log('\n=== Pipeline 2 — HN Funding Intelligence — Local Test ===\n');

    // Step 1: Poll HN for recent stories
    console.log('Polling HN Algolia for recent funding stories...\n');
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const allStories = new Map<string, HNStory>();

    for (const term of SEARCH_TERMS) {
      try {
        const params = new URLSearchParams({
          query: term,
          tags: 'story',
          numericFilters: `created_at_i>${twoHoursAgo},points>5`,
        });
        const res = await fetch(`${HN_SEARCH_URL}?${params}`);
        if (!res.ok) continue;
        const data = (await res.json()) as HNSearchResponse;
        for (const hit of data.hits) {
          if (!allStories.has(hit.objectID)) {
            allStories.set(hit.objectID, hit);
          }
        }
      } catch {
        // skip
      }
    }

    // Apply title filter to test results too
    const rawStories = Array.from(allStories.values());
    const stories = rawStories.filter((s) => isFundingSignal(s.title));
    console.log(`Found ${rawStories.length} raw stories, ${stories.length} passed title filter\n`);

    for (const s of stories.slice(0, 10)) {
      const name = extractCompanyName(s.title);
      console.log(`  [${s.objectID}] ${s.title}`);
      console.log(`    → Company: "${name}" | Points: ${s.points} | Author: ${s.author}`);
      console.log(`    → URL: ${s.url || '(none)'}\n`);
    }

    if (stories.length === 0) {
      console.log('No qualifying stories found. To test the research agent, run:');
      console.log('  npx ts-node src/pipelines/hn-funding.ts <story_id> <company_name>\n');

      const storyId = process.argv[2];
      const companyNameArg = process.argv[3];

      if (!storyId) {
        process.exit(0);
      }

      console.log(`\nTesting story ${storyId} for "${companyNameArg || 'unknown'}"...\n`);

      // YC directory gate applies in test mode too
      const ycResult = await lookupYCDirectory(companyNameArg || 'Unknown');
      if (!ycResult) {
        console.log(`Skipping — not a YC company (not found in YC directory)\n`);
        process.exit(0);
      }
      console.log(`✓ YC company confirmed: ${ycResult.batch} | ${ycResult.one_liner}\n`);

      const research = await runResearchAgent(
        companyNameArg || 'Unknown',
        '',
        storyId,
        '',
        ycResult
      );

      printResearchData(research);

      if (process.env.OPENAI_API_KEY) {
        console.log('\n--- GPT-4o Synthesis ---\n');
        const card = await synthesiseIntelCard(research, {
          hn_story_id: storyId,
          hn_comment_id: null,
          pipeline: 'funding',
          company_name: companyNameArg || 'Unknown',
          company_url: research.ycDirectory?.website || '',
          raw_hn_comment: null,
          do_not_contact: false,
        });
        printIntelCard(card);
      } else {
        console.log('\n⚠ Set OPENAI_API_KEY to run GPT-4o synthesis\n');
      }

      process.exit(0);
    }

    // Pick the first story and run research
    const story = stories[0];
    const companyName = process.argv[2] || extractCompanyName(story.title);
    console.log(`\n--- Processing: "${companyName}" (story ${story.objectID}) ---\n`);

    // YC directory gate
    const ycResult = await lookupYCDirectory(companyName);
    if (!ycResult) {
      console.log(`Skipping — not a YC company (not found in YC directory)\n`);
      process.exit(0);
    }
    console.log(`✓ YC company confirmed: ${ycResult.batch} | ${ycResult.one_liner}\n`);

    const research = await runResearchAgent(
      companyName,
      story.url || '',
      story.objectID,
      story.author,
      ycResult
    );

    printResearchData(research);

    if (process.env.OPENAI_API_KEY) {
      console.log('\n--- GPT-4o Synthesis ---\n');
      const card = await synthesiseIntelCard(research, {
        hn_story_id: story.objectID,
        hn_comment_id: null,
        pipeline: 'funding',
        company_name: companyName,
        company_url: research.ycDirectory?.website || story.url || '',
        raw_hn_comment: null,
        do_not_contact: false,
      });
      printIntelCard(card);
    } else {
      console.log('\n⚠ Set OPENAI_API_KEY to run GPT-4o synthesis\n');
    }

    process.exit(0);
  })().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

function printResearchData(research: ResearchData): void {
  console.log('=== Research Results ===\n');

  if (research.ycDirectory) {
    console.log('YC Directory:');
    console.log(`  Batch: ${research.ycDirectory.batch}`);
    console.log(`  Founders: ${research.ycDirectory.founders.join(', ')}`);
    console.log(`  One-liner: ${research.ycDirectory.one_liner}`);
    console.log(`  Team size: ${research.ycDirectory.team_size}`);
    console.log(`  Website: ${research.ycDirectory.website}`);
  } else {
    console.log('YC Directory: not found');
  }

  console.log();
  if (research.careers) {
    console.log(`Careers Page: ${research.careers.careers_url}`);
    console.log(`  ATS: ${research.careers.ats_detected}`);
    console.log(`  Roles (${research.careers.roles.length}):`);
    for (const [dept, count] of Object.entries(research.careers.role_counts_by_dept)) {
      console.log(`    ${dept}: ${count}`);
    }
  } else {
    console.log('Careers Page: not found');
  }

  console.log();
  if (research.press.length > 0) {
    console.log(`Press Coverage (${research.press.length} articles):`);
    for (const p of research.press) {
      console.log(`  [${p.source}] ${p.headline}`);
      if (p.quotes.length > 0) {
        console.log(`    Quotes: ${p.quotes.join(' | ')}`);
      }
    }
  } else {
    console.log('Press Coverage: none found');
  }

  console.log();
  if (research.hnThread) {
    console.log(`HN Thread:`);
    console.log(`  Author replies: ${research.hnThread.author_replies.length}`);
    console.log(`  Relevant comments: ${research.hnThread.relevant_comments.length}`);
    if (research.hnThread.author_replies.length > 0) {
      console.log(`  First author reply: "${research.hnThread.author_replies[0].slice(0, 150)}..."`);
    }
  } else {
    console.log('HN Thread: not found');
  }

  console.log();
  if (research.blog) {
    console.log(`Blog Post: "${research.blog.post_title}" (${research.blog.post_date})`);
    console.log(`  URL: ${research.blog.post_url}`);
    console.log(`  Excerpt: ${research.blog.post_excerpt.slice(0, 200)}...`);
  } else {
    console.log('Blog: not found');
  }
}

function printIntelCard(card: IntelCard): void {
  console.log('═══════════════════════════════════════');
  console.log(`COMPANY INTEL: ${card.company_name} (YC ${card.company_batch})`);
  console.log('═══════════════════════════════════════');
  console.log(`Stage: ${card.funding_stage} ${card.funding_amount}`);
  console.log(`Website: ${card.company_url} | Headcount: ~${card.headcount_estimate}`);
  console.log();
  console.log('FOUNDERS');
  for (const f of card.founder_backgrounds) {
    console.log(`  ${f.name} — ${f.prior_companies}`);
    console.log(`  → ${f.relevant_signal}`);
  }
  console.log();
  console.log('WHAT THEY DO');
  console.log(`  ${card.what_they_do}`);
  console.log();
  console.log('FUNDING CONTEXT');
  console.log(`  Use of funds: ${card.use_of_funds}`);
  console.log();
  console.log('HIRING SIGNALS');
  if (card.careers_url) {
    console.log(`  Careers page: ${card.careers_url}`);
    console.log(`  Open roles: ${card.open_roles_count} total`);
    for (const [dept, count] of Object.entries(card.open_roles_breakdown)) {
      console.log(`    ${dept}: ${count}`);
    }
  } else {
    console.log('  No careers page found');
  }
  console.log(`  ATS: ${card.ats_detected}`);
  console.log();
  console.log(`SALES HIRING HISTORY`);
  console.log(`  Prior sales hires: ${card.sales_hire_count}`);
  console.log();
  console.log(`OPPORTUNITY SCORE: ${card.opportunity_score}/10`);
  console.log(`  Suggested angle: ${card.suggested_angle}`);
  console.log('═══════════════════════════════════════\n');
}
