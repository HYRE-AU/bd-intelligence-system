/**
 * Test Pipeline 3 — HN Hiring Signal Monitor
 *
 * Polls HN for hiring-related comments, identifies commenters,
 * runs research agent on first match. No Supabase, no emails.
 *
 * Usage:
 *   npx ts-node scripts/test-pipeline-3.ts                   # poll live HN
 *   npx ts-node scripts/test-pipeline-3.ts <comment_id>      # test specific comment
 */
import 'dotenv/config';
import { runResearchAgent } from '../src/pipelines/hn-funding';
import { lookupYCDirectory } from '../src/research/yc-directory';
import { crawlCareersPage } from '../src/research/careers-crawler';
import { synthesiseIntelCard } from '../src/research/synthesise';
import type { IntelCard, ResearchData } from '../src/types';

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HN_USER_URL = 'https://hn.algolia.com/api/v1/users';

const SEARCH_TERMS = [
  'looking to hire', 'hiring for', 'need an AE', 'first sales hire',
  'founding AE', 'building our sales team', 'struggling to hire',
  "can't find a good", 'sales person', 'head of sales',
  'referrals welcome', 'know anyone who',
];

interface HNComment {
  objectID: string;
  comment_text: string;
  author: string;
  story_id: number;
  story_title: string;
}

interface CommenterIdentity {
  username: string;
  bio: string;
  linkedUrl: string;
  companyName: string;
  isYCFounder: boolean;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function identifyCommenter(username: string): Promise<CommenterIdentity> {
  const identity: CommenterIdentity = {
    username, bio: '', linkedUrl: '', companyName: '', isYCFounder: false,
  };

  try {
    const res = await fetch(`${HN_USER_URL}/${username}`);
    if (res.ok) {
      const user = await res.json() as { about: string | null };
      identity.bio = stripHtml(user.about || '');
      const urlMatch = identity.bio.match(/https?:\/\/[^\s<>"]+/i);
      if (urlMatch) identity.linkedUrl = urlMatch[0];
    }
  } catch { /* skip */ }

  const companyPatterns = [
    /(?:ceo|cto|founder|co-founder|cofounder)\s+(?:at|of|@)\s+([A-Z][A-Za-z0-9\s]+)/i,
    /(?:building|working on|created)\s+([A-Z][A-Za-z0-9\s]+)/i,
  ];
  for (const pattern of companyPatterns) {
    const match = identity.bio.match(pattern);
    if (match) {
      identity.companyName = match[1].trim().split(/[.,;!?\n]/)[0].trim();
      break;
    }
  }

  if (identity.companyName) {
    try {
      const yc = await lookupYCDirectory(identity.companyName);
      if (yc) {
        identity.isYCFounder = true;
        if (!identity.linkedUrl) identity.linkedUrl = yc.website;
      }
    } catch { /* skip */ }
  }

  if (!identity.isYCFounder && identity.linkedUrl) {
    try {
      const domain = new URL(identity.linkedUrl).hostname.replace('www.', '');
      const name = domain.split('.')[0];
      const yc = await lookupYCDirectory(name);
      if (yc) {
        identity.isYCFounder = true;
        identity.companyName = identity.companyName || name;
      }
    } catch { /* skip */ }
  }

  return identity;
}

(async () => {
  console.log('\n=== Pipeline 3 — HN Hiring Signal Monitor ===\n');

  const commentIdArg = process.argv[2];

  if (commentIdArg) {
    // Direct comment test
    console.log(`Fetching comment ${commentIdArg}...\n`);
    const res = await fetch(`https://hn.algolia.com/api/v1/items/${commentIdArg}`);
    if (!res.ok) {
      console.error(`Failed to fetch comment: ${res.status}`);
      process.exit(1);
    }
    const item = await res.json() as { author: string; text: string; story_id: number; parent_id: number };

    console.log(`Author: @${item.author}`);
    console.log(`Comment: "${stripHtml(item.text || '').slice(0, 200)}"\n`);

    await processCommenter(item.author, String(item.story_id || item.parent_id), stripHtml(item.text || ''));
    process.exit(0);
  }

  // Poll for live comments
  console.log('Polling HN for hiring-related comments (last 2 hours)...\n');
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
  const allComments = new Map<string, HNComment>();

  for (const term of SEARCH_TERMS) {
    try {
      const params = new URLSearchParams({
        query: `"${term}"`,
        tags: 'comment',
        numericFilters: `created_at_i>${twoHoursAgo}`,
      });
      const res = await fetch(`${HN_SEARCH_URL}?${params}`);
      if (!res.ok) continue;
      const data = await res.json() as { hits: HNComment[] };
      for (const hit of data.hits) {
        if (!allComments.has(hit.objectID)) allComments.set(hit.objectID, hit);
      }
    } catch { /* skip */ }
  }

  let comments = Array.from(allComments.values());
  console.log(`Found ${comments.length} comments in last 2 hours\n`);

  if (comments.length === 0) {
    console.log('Expanding to last 24 hours...\n');
    const oneDayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    for (const term of SEARCH_TERMS.slice(0, 6)) {
      try {
        const params = new URLSearchParams({
          query: `"${term}"`,
          tags: 'comment',
          numericFilters: `created_at_i>${oneDayAgo}`,
          hitsPerPage: '3',
        });
        const res = await fetch(`${HN_SEARCH_URL}?${params}`);
        if (!res.ok) continue;
        const data = await res.json() as { hits: HNComment[] };
        for (const hit of data.hits) {
          if (!allComments.has(hit.objectID)) allComments.set(hit.objectID, hit);
        }
      } catch { /* skip */ }
    }
    comments = Array.from(allComments.values());

    if (comments.length === 0) {
      console.log('No comments found. Try passing a comment ID:\n');
      console.log('  npx ts-node scripts/test-pipeline-3.ts <comment_id>\n');
      process.exit(0);
    }

    console.log(`Found ${comments.length} comments in last 24 hours:\n`);
  }

  for (const c of comments.slice(0, 10)) {
    const text = stripHtml(c.comment_text).slice(0, 100);
    console.log(`  [${c.objectID}] @${c.author} in "${(c.story_title || '').slice(0, 50)}"`);
    console.log(`    "${text}..."\n`);
  }

  // Process first comment
  const comment = comments[0];
  console.log(`\n--- Processing @${comment.author} ---\n`);
  await processCommenter(comment.author, String(comment.story_id), stripHtml(comment.comment_text));

  process.exit(0);
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

async function processCommenter(username: string, storyId: string, commentText: string): Promise<void> {
  console.log('Identifying commenter...\n');
  const identity = await identifyCommenter(username);

  console.log(`  Username:   @${identity.username}`);
  console.log(`  Bio:        ${identity.bio.slice(0, 200) || '(empty)'}`);
  console.log(`  Linked URL: ${identity.linkedUrl || '(none)'}`);
  console.log(`  Company:    ${identity.companyName || '(unknown)'}`);
  console.log(`  YC Founder: ${identity.isYCFounder}\n`);

  if (!identity.companyName && !identity.linkedUrl) {
    console.log('No company identified — skipping research.\n');
    return;
  }

  const companyName = identity.companyName || 'Unknown';
  console.log(`--- Running research agent for "${companyName}" ---\n`);

  let research: ResearchData;
  if (identity.isYCFounder) {
    research = await runResearchAgent(companyName, identity.linkedUrl, storyId, username);
  } else {
    let careers = null;
    if (identity.linkedUrl) {
      try { careers = await crawlCareersPage(identity.linkedUrl); } catch { /* skip */ }
    }
    research = { ycDirectory: null, careers, press: [], hnThread: null, blog: null };
  }

  printResearch(research);

  if (process.env.OPENAI_API_KEY) {
    console.log('\n--- GPT-4o Synthesis ---\n');
    const card = await synthesiseIntelCard(research, {
      hn_story_id: storyId,
      hn_comment_id: 'test',
      pipeline: 'hn_signal',
      company_name: companyName,
      company_url: research.ycDirectory?.website || identity.linkedUrl || '',
      raw_hn_comment: commentText,
      do_not_contact: false,
    });
    printIntelCard(card, username);
  } else {
    console.log('\n⚠ Set OPENAI_API_KEY in .env to test GPT-4o synthesis\n');
  }
}

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
    console.log(`  ${r.careers.roles.length} roles`);
  } else {
    console.log('\nCareers: not found');
  }

  console.log(`\nPress: ${r.press.length > 0 ? r.press.length + ' articles' : 'none'}`);
  console.log(`HN Thread: ${r.hnThread ? r.hnThread.relevant_comments.length + ' relevant comments' : 'not found'}`);
  console.log(`Blog: ${r.blog ? '"' + r.blog.post_title + '"' : 'not found'}`);
}

function printIntelCard(card: IntelCard, username: string): void {
  console.log('═══════════════════════════════════════');
  console.log(`HIRING SIGNAL ON HN: @${username}`);
  console.log('═══════════════════════════════════════');
  if (card.raw_hn_comment) {
    console.log(`"${card.raw_hn_comment.slice(0, 200)}"`);
  }
  console.log();
  console.log(`COMPANY: ${card.company_name} (YC ${card.company_batch || '??'})`);
  console.log(`Website: ${card.company_url} | Headcount: ~${card.headcount_estimate}`);
  console.log(`\nWHAT THEY DO\n  ${card.what_they_do}`);
  if (card.careers_url) {
    console.log(`\nCAREERS: ${card.careers_url} | ATS: ${card.ats_detected}`);
    console.log(`  Open roles: ${card.open_roles_count}`);
    for (const [dept, n] of Object.entries(card.open_roles_breakdown)) {
      console.log(`    ${dept}: ${n}`);
    }
  }
  console.log(`\nSales hire count: ${card.sales_hire_count}`);
  console.log(`\nOPPORTUNITY SCORE: ${card.opportunity_score}/10${card.opportunity_score >= 8 ? ' 🔥' : ''}`);
  console.log(`Suggested angle: ${card.suggested_angle}`);
  console.log('═══════════════════════════════════════\n');
}
