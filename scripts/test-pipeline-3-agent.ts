/**
 * Test Pipeline 3 research agent with a hardcoded hiring signal scenario.
 * No HN polling, no Supabase, no emails.
 *
 * Usage:
 *   npx ts-node scripts/test-pipeline-3-agent.ts                # uses Airbnb
 *   npx ts-node scripts/test-pipeline-3-agent.ts <company_name> # custom company
 */
import 'dotenv/config';
import { runResearchAgent } from '../src/pipelines/hn-funding';
import { lookupYCDirectory } from '../src/research/yc-directory';
import { synthesiseIntelCard } from '../src/research/synthesise';
import type { IntelCard, ResearchData } from '../src/types';

// ── Hardcoded test scenario ──

const TEST_USERNAME = 'jsmith';
const TEST_COMMENT =
  "We've been trying to hire our first AE for 3 months, it's way harder than expected. Anyone have referrals?";
const TEST_COMMENT_ID = 'test-12345';
const DEFAULT_COMPANY = 'Airbnb';

(async () => {
  const companyName = process.argv[2] || DEFAULT_COMPANY;

  console.log('\n=== Pipeline 3 — Research Agent Test ===\n');
  console.log('═══════════════════════════════════════');
  console.log(`HIRING SIGNAL ON HN: @${TEST_USERNAME}`);
  console.log('═══════════════════════════════════════');
  console.log(`"${TEST_COMMENT}"`);
  console.log(`→ https://news.ycombinator.com/item?id=${TEST_COMMENT_ID}`);
  console.log();

  // YC directory lookup
  const ycResult = await lookupYCDirectory(companyName);
  if (!ycResult) {
    console.log(`"${companyName}" not found in YC directory. Try a different company.\n`);
    process.exit(1);
  }
  console.log(`✓ YC match: ${ycResult.batch} | ${ycResult.one_liner}`);
  console.log(`  Website: ${ycResult.website} | Team: ${ycResult.team_size}\n`);

  // Run research agent
  console.log('--- Running Research Agent ---\n');
  const research = await runResearchAgent(
    companyName,
    ycResult.website,
    '0',
    TEST_USERNAME,
    ycResult
  );
  printResearch(research);

  // GPT-4o synthesis
  if (!process.env.OPENAI_API_KEY) {
    console.log('\n⚠ Set OPENAI_API_KEY in .env to test GPT-4o synthesis\n');
    process.exit(0);
  }

  console.log('\n--- GPT-4o Synthesis ---\n');
  const card = await synthesiseIntelCard(research, {
    hn_story_id: null,
    hn_comment_id: TEST_COMMENT_ID,
    pipeline: 'hn_signal',
    company_name: companyName,
    company_url: ycResult.website,
    raw_hn_comment: TEST_COMMENT,
    do_not_contact: false,
  });
  printIntelCard(card);

  process.exit(0);
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

function printResearch(r: ResearchData): void {
  if (r.ycDirectory) {
    console.log('YC Directory:');
    console.log(`  Batch: ${r.ycDirectory.batch} | Team: ${r.ycDirectory.team_size} | Site: ${r.ycDirectory.website}`);
    console.log(`  "${r.ycDirectory.one_liner}"`);
  } else {
    console.log('YC Directory: not found');
  }

  if (r.careers) {
    console.log(`\nCareers: ${r.careers.careers_url} | ATS: ${r.careers.ats_detected}`);
    console.log(`  ${r.careers.roles.length} open roles:`);
    for (const [dept, n] of Object.entries(r.careers.role_counts_by_dept)) {
      console.log(`    ${dept}: ${n}`);
    }
  } else {
    console.log('\nCareers: not found');
  }

  console.log(`\nPress: ${r.press.length > 0 ? r.press.map(p => `[${p.source}] ${p.headline}`).join(', ') : 'none'}`);

  if (r.hnThread) {
    console.log(`\nHN Thread: ${r.hnThread.author_replies.length} author replies, ${r.hnThread.relevant_comments.length} relevant comments`);
  } else {
    console.log('\nHN Thread: not fetched');
  }

  if (r.blog) {
    console.log(`\nBlog: "${r.blog.post_title}" (${r.blog.post_date})`);
    console.log(`  ${r.blog.post_excerpt.slice(0, 200)}...`);
  } else {
    console.log('\nBlog: not found');
  }
}

function printIntelCard(card: IntelCard): void {
  console.log('═══════════════════════════════════════');
  console.log(`HIRING SIGNAL ON HN: @${TEST_USERNAME}`);
  console.log('═══════════════════════════════════════');
  console.log(`"${card.raw_hn_comment}"`);
  console.log(`→ https://news.ycombinator.com/item?id=${card.hn_comment_id}`);
  console.log();
  console.log(`COMPANY: ${card.company_name} (YC ${card.company_batch || '??'})`);
  console.log(`Website: ${card.company_url} | Headcount: ~${card.headcount_estimate}`);
  console.log();
  console.log('WHAT THEY DO');
  console.log(`  ${card.what_they_do}`);
  console.log();
  console.log('USE OF FUNDS');
  console.log(`  ${card.use_of_funds || '(not available)'}`);
  console.log();
  console.log('HIRING SIGNALS');
  if (card.careers_url) {
    console.log(`  Careers: ${card.careers_url} | ATS: ${card.ats_detected}`);
    console.log(`  Open roles: ${card.open_roles_count}`);
    for (const [dept, n] of Object.entries(card.open_roles_breakdown)) {
      console.log(`    ${dept}: ${n}`);
    }
  } else {
    console.log('  No careers page found');
  }
  console.log(`\nSales hire count: ${card.sales_hire_count}`);
  console.log();
  console.log('FOUNDERS');
  for (const f of card.founder_backgrounds) {
    console.log(`  ${f.name} — ${f.prior_companies}`);
    console.log(`  → ${f.relevant_signal}`);
  }
  console.log();
  console.log(`OPPORTUNITY SCORE: ${card.opportunity_score}/10${card.opportunity_score >= 8 ? ' 🔥' : ''}`);
  console.log(`Suggested angle: ${card.suggested_angle}`);
  console.log('═══════════════════════════════════════\n');
}
