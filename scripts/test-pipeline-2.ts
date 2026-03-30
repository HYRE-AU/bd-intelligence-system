/**
 * Test Pipeline 2 — HN Funding Intelligence
 *
 * Usage:
 *   npx ts-node scripts/test-pipeline-2.ts                         # poll live HN (dry run)
 *   npx ts-node scripts/test-pipeline-2.ts <story_id> <company>    # test specific story
 */
import 'dotenv/config';
import { runHNFundingPipeline, runResearchAgent } from '../src/pipelines/hn-funding';
import { lookupYCDirectory } from '../src/research/yc-directory';
import { synthesiseIntelCard } from '../src/research/synthesise';
import type { IntelCard, ResearchData } from '../src/types';

(async () => {
  console.log('\n=== Pipeline 2 — HN Funding Intelligence (dry run) ===\n');

  const storyIdArg = process.argv[2];
  const companyNameArg = process.argv[3];

  if (storyIdArg && companyNameArg) {
    // ── Direct test: skip HN poll, run research on specific story ──
    console.log(`Testing story ${storyIdArg}, company "${companyNameArg}"\n`);

    // YC directory gate
    const ycResult = await lookupYCDirectory(companyNameArg);
    if (!ycResult) {
      console.log(`Skipping — not a YC company (not found in YC directory)\n`);
      process.exit(0);
    }
    console.log(`✓ YC company confirmed: ${ycResult.batch} | ${ycResult.one_liner}\n`);

    // Run research agent
    console.log('--- Running Research Agent ---\n');
    const research = await runResearchAgent(
      companyNameArg,
      '',
      storyIdArg,
      '',
      ycResult
    );
    printResearch(research);

    // GPT-4o synthesis
    if (process.env.OPENAI_API_KEY) {
      console.log('\n--- GPT-4o Synthesis ---\n');
      const card = await synthesiseIntelCard(research, {
        hn_story_id: storyIdArg,
        hn_comment_id: null,
        pipeline: 'funding',
        company_name: companyNameArg,
        company_url: research.ycDirectory?.website || '',
        raw_hn_comment: null,
        do_not_contact: false,
      });
      printIntelCard(card);
    } else {
      console.log('\n⚠ Set OPENAI_API_KEY in .env to test GPT-4o synthesis\n');
    }
  } else {
    // ── Live poll: use the real pipeline with all filters ──
    const cards = await runHNFundingPipeline({ dryRun: true });

    if (cards.length === 0) {
      console.log('\nNo intel cards generated (no qualifying YC stories found).\n');
    } else {
      console.log(`\n--- ${cards.length} Intel Card(s) Generated ---\n`);
      for (const card of cards) {
        printIntelCard(card);
      }
    }
  }

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
    for (const reply of r.hnThread.author_replies.slice(0, 2)) {
      console.log(`  Author: "${reply.slice(0, 150)}..."`);
    }
  } else {
    console.log('\nHN Thread: not found');
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
  console.log(`COMPANY INTEL: ${card.company_name} (YC ${card.company_batch || '??'})`);
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
  console.log(`OPPORTUNITY SCORE: ${card.opportunity_score}/10${card.opportunity_score >= 8 ? ' 🔥' : ''}`);
  console.log(`Suggested angle: ${card.suggested_angle}`);
  console.log('═══════════════════════════════════════\n');
}
