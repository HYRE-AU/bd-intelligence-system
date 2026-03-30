import { lookupYCDirectory } from '../research/yc-directory';
import { crawlCareersPage } from '../research/careers-crawler';
import { searchPressRSS } from '../research/press-rss';
import { extractHNThread } from '../research/hn-thread';
import { crawlBlog } from '../research/blog-crawler';
import { synthesiseIntelCard } from '../research/synthesise';
import { runResearchAgent } from './hn-funding';
import {
  commentIdExists,
  insertDedupLog,
  isDoNotContact,
  insertIntelCard,
} from '../db/supabase';
import { sendIntelCardEmail } from '../email/intel-card';
import type { IntelCard, ResearchData } from '../types';

// ── HN Algolia search terms for hiring signals ──

const SEARCH_TERMS = [
  'looking to hire',
  'hiring for',
  'need an AE',
  'first sales hire',
  'founding AE',
  'building our sales team',
  'struggling to hire',
  "can't find a good",
  'sales person',
  'head of sales',
  'referrals welcome',
  'know anyone who',
];

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HN_USER_URL = 'https://hn.algolia.com/api/v1/users';

interface HNComment {
  objectID: string;
  comment_text: string;
  author: string;
  story_id: number;
  story_title: string;
  story_url: string | null;
  created_at: string;
  points: number | null;
}

interface HNSearchResponse {
  hits: HNComment[];
}

interface HNUser {
  username: string;
  about: string | null;
  karma: number;
}

interface CommenterIdentity {
  username: string;
  bio: string;
  linkedUrl: string;
  companyName: string;
  isYCFounder: boolean;
}

/**
 * Poll HN Algolia API for hiring-related comments.
 * Filter: comments only, created in last 2 hours.
 */
async function pollHNHiringComments(): Promise<HNComment[]> {
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

      const data = (await res.json()) as HNSearchResponse;
      for (const hit of data.hits) {
        if (!allComments.has(hit.objectID)) {
          allComments.set(hit.objectID, hit);
        }
      }
    } catch (err) {
      console.error(`HN comment search failed for "${term}":`, err);
    }
  }

  return Array.from(allComments.values());
}

/**
 * Identify the HN commenter: fetch their profile, extract bio/website,
 * cross-reference YC directory to check if they're a founder.
 */
async function identifyCommenter(
  username: string
): Promise<CommenterIdentity> {
  const identity: CommenterIdentity = {
    username,
    bio: '',
    linkedUrl: '',
    companyName: '',
    isYCFounder: false,
  };

  // Fetch HN user profile
  try {
    const res = await fetch(`${HN_USER_URL}/${username}`);
    if (res.ok) {
      const user = (await res.json()) as HNUser;
      identity.bio = stripHtml(user.about || '');

      // Extract URL from bio
      const urlMatch = identity.bio.match(
        /https?:\/\/[^\s<>"]+/i
      );
      if (urlMatch) {
        identity.linkedUrl = urlMatch[0];
      }
    }
  } catch {
    // Profile fetch failed, proceed with what we have
  }

  // Try to extract company name from bio
  // Common patterns: "CEO at Company", "Founder of Company", "Working on Company"
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

  // If we found a company name, cross-reference YC directory
  if (identity.companyName) {
    try {
      const ycResult = await lookupYCDirectory(identity.companyName);
      if (ycResult) {
        identity.isYCFounder = true;
        // Use canonical company name from YC directory
        if (!identity.linkedUrl) {
          identity.linkedUrl = ycResult.website;
        }
      }
    } catch {
      // YC lookup failed, proceed without
    }
  }

  // Also try matching website domain against YC directory
  if (!identity.isYCFounder && identity.linkedUrl) {
    try {
      const domain = new URL(identity.linkedUrl).hostname.replace('www.', '');
      const companyFromDomain = domain.split('.')[0];
      const ycResult = await lookupYCDirectory(companyFromDomain);
      if (ycResult) {
        identity.isYCFounder = true;
        identity.companyName = identity.companyName || companyFromDomain;
      }
    } catch {
      // URL parse or YC lookup failed
    }
  }

  return identity;
}

/**
 * Pipeline 3 main entry: poll HN for hiring comments,
 * identify commenters, research companies, send intel cards.
 */
export async function runHNSignalsPipeline(): Promise<IntelCard[]> {
  console.log('Pipeline 3: Polling HN for hiring signal comments...');
  const comments = await pollHNHiringComments();
  console.log(`Found ${comments.length} recent hiring-related comments`);

  const cards: IntelCard[] = [];

  for (const comment of comments) {
    try {
      // Dedup check
      const exists = await commentIdExists(comment.objectID);
      if (exists) {
        await insertDedupLog('hn_comment', comment.objectID);
        continue;
      }

      console.log(
        `\nProcessing comment by @${comment.author}: "${stripHtml(comment.comment_text).slice(0, 80)}..."`
      );

      // Step 1: Identify commenter
      const identity = await identifyCommenter(comment.author);
      console.log(
        `  Identity: ${identity.companyName || '(unknown company)'} | YC founder: ${identity.isYCFounder}`
      );

      // Need at least a company name to proceed
      if (!identity.companyName && !identity.linkedUrl) {
        console.log('  Skipping — no company identified');
        await insertDedupLog('hn_comment', comment.objectID);
        continue;
      }

      const companyName = identity.companyName || 'Unknown';

      // DNC check
      const dnc = await isDoNotContact(companyName);
      if (dnc) {
        console.log(`  Skipping ${companyName} — do not contact`);
        await insertDedupLog('dnc_skip', comment.objectID);
        continue;
      }

      let research: ResearchData;

      if (identity.isYCFounder) {
        // Step 2: YC founder confirmed — run full research agent
        research = await runResearchAgent(
          companyName,
          identity.linkedUrl,
          String(comment.story_id),
          comment.author
        );
      } else {
        // Step 3: Not confirmed YC founder — careers crawl + partial research
        let careers = null;
        if (identity.linkedUrl) {
          try {
            careers = await crawlCareersPage(identity.linkedUrl);
          } catch {
            // Careers crawl failed
          }
        }

        // Still run press + HN thread in parallel
        const [pressResult, hnResult] = await Promise.allSettled([
          searchPressRSS(companyName),
          extractHNThread(String(comment.story_id), comment.author),
        ]);

        research = {
          ycDirectory: null,
          careers,
          press: pressResult.status === 'fulfilled' ? pressResult.value : [],
          hnThread: hnResult.status === 'fulfilled' ? hnResult.value : null,
          blog: null,
        };
      }

      // Synthesise intel card
      const rawComment = stripHtml(comment.comment_text);
      const card = await synthesiseIntelCard(research, {
        hn_story_id: String(comment.story_id),
        hn_comment_id: comment.objectID,
        pipeline: 'hn_signal',
        company_name: companyName,
        company_url:
          research.ycDirectory?.website || identity.linkedUrl || '',
        raw_hn_comment: rawComment,
        do_not_contact: false,
      });

      // Store in Supabase
      await insertIntelCard(card as unknown as Record<string, unknown>);
      await insertDedupLog('hn_comment', comment.objectID);

      // Send email immediately
      await sendIntelCardEmail(card, comment.author);

      cards.push(card);
      console.log(
        `  ✓ Intel card generated: ${companyName} — score ${card.opportunity_score}/10`
      );
    } catch (err) {
      console.error(`Failed to process comment ${comment.objectID}:`, err);
    }
  }

  return cards;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Local test mode ──
// Run with: npx ts-node src/pipelines/hn-signals.ts
//
// Polls for live hiring comments. If none found, you can pass a comment ID:
//   npx ts-node src/pipelines/hn-signals.ts <comment_id>

if (require.main === module) {
  (async () => {
    console.log('\n=== Pipeline 3 — HN Hiring Signal Monitor — Local Test ===\n');

    // Check for direct comment ID argument
    const commentIdArg = process.argv[2];

    if (commentIdArg) {
      console.log(`Fetching comment ${commentIdArg}...\n`);

      const res = await fetch(
        `https://hn.algolia.com/api/v1/items/${commentIdArg}`
      );
      if (!res.ok) {
        console.error(`Failed to fetch comment: ${res.status}`);
        process.exit(1);
      }

      const item = (await res.json()) as {
        author: string;
        text: string;
        story_id: number;
        parent_id: number;
      };

      console.log(`Author: @${item.author}`);
      console.log(`Comment: "${stripHtml(item.text || '').slice(0, 200)}"`);
      console.log();

      // Identify commenter
      console.log('--- Identifying commenter ---\n');
      const identity = await identifyCommenter(item.author);
      console.log(`  Username: @${identity.username}`);
      console.log(`  Bio: ${identity.bio.slice(0, 200) || '(empty)'}`);
      console.log(`  Linked URL: ${identity.linkedUrl || '(none)'}`);
      console.log(`  Company: ${identity.companyName || '(unknown)'}`);
      console.log(`  YC Founder: ${identity.isYCFounder}`);

      if (identity.companyName || identity.linkedUrl) {
        const companyName = identity.companyName || 'Unknown';
        console.log(
          `\n--- Running research agent for "${companyName}" ---\n`
        );

        let research: ResearchData;
        if (identity.isYCFounder) {
          research = await runResearchAgent(
            companyName,
            identity.linkedUrl,
            String(item.story_id || item.parent_id),
            item.author
          );
        } else {
          let careers = null;
          if (identity.linkedUrl) {
            try { careers = await crawlCareersPage(identity.linkedUrl); } catch {}
          }
          research = {
            ycDirectory: null,
            careers,
            press: [],
            hnThread: null,
            blog: null,
          };
        }

        printResearchSummary(research);

        if (process.env.OPENAI_API_KEY) {
          console.log('\n--- GPT-4o Synthesis ---\n');
          const card = await synthesiseIntelCard(research, {
            hn_story_id: String(item.story_id || item.parent_id),
            hn_comment_id: commentIdArg,
            pipeline: 'hn_signal',
            company_name: companyName,
            company_url: research.ycDirectory?.website || identity.linkedUrl || '',
            raw_hn_comment: stripHtml(item.text || ''),
            do_not_contact: false,
          });
          printIntelCard(card, item.author);
        } else {
          console.log('\n⚠ Set OPENAI_API_KEY to run GPT-4o synthesis\n');
        }
      }

      process.exit(0);
    }

    // Poll for live comments
    console.log('Polling HN Algolia for recent hiring comments...\n');
    const comments = await pollHNHiringComments();
    console.log(`Found ${comments.length} comments in last 2 hours:\n`);

    for (const c of comments.slice(0, 10)) {
      const text = stripHtml(c.comment_text).slice(0, 120);
      console.log(`  [${c.objectID}] @${c.author} in "${c.story_title?.slice(0, 50)}"`);
      console.log(`    "${text}..."`);
      console.log();
    }

    if (comments.length === 0) {
      console.log('No live comments found.');
      console.log('To test with a specific comment, run:');
      console.log('  npx ts-node src/pipelines/hn-signals.ts <comment_id>\n');
      process.exit(0);
    }

    // Process first comment
    const comment = comments[0];
    console.log(`\n--- Processing first comment by @${comment.author} ---\n`);

    const identity = await identifyCommenter(comment.author);
    console.log(`  Username: @${identity.username}`);
    console.log(`  Bio: ${identity.bio.slice(0, 200) || '(empty)'}`);
    console.log(`  Company: ${identity.companyName || '(unknown)'}`);
    console.log(`  YC Founder: ${identity.isYCFounder}`);

    if (identity.companyName || identity.linkedUrl) {
      const companyName = identity.companyName || 'Unknown';
      console.log(`\n--- Running research agent for "${companyName}" ---\n`);

      const research = await runResearchAgent(
        companyName,
        identity.linkedUrl,
        String(comment.story_id),
        comment.author
      );
      printResearchSummary(research);
    }

    process.exit(0);
  })().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

function printResearchSummary(research: ResearchData): void {
  console.log('=== Research Results ===\n');

  if (research.ycDirectory) {
    console.log('YC Directory:');
    console.log(`  Batch: ${research.ycDirectory.batch}`);
    console.log(`  One-liner: ${research.ycDirectory.one_liner}`);
    console.log(`  Team size: ${research.ycDirectory.team_size}`);
    console.log(`  Website: ${research.ycDirectory.website}`);
  } else {
    console.log('YC Directory: not found');
  }

  if (research.careers) {
    console.log(`\nCareers Page: ${research.careers.careers_url}`);
    console.log(`  ATS: ${research.careers.ats_detected}`);
    console.log(`  Roles: ${research.careers.roles.length}`);
  } else {
    console.log('\nCareers Page: not found');
  }

  if (research.press.length > 0) {
    console.log(`\nPress: ${research.press.length} articles`);
  } else {
    console.log('\nPress: none');
  }

  if (research.hnThread) {
    console.log(`\nHN Thread: ${research.hnThread.author_replies.length} author replies, ${research.hnThread.relevant_comments.length} relevant comments`);
  } else {
    console.log('\nHN Thread: not found');
  }

  if (research.blog) {
    console.log(`\nBlog: "${research.blog.post_title}" (${research.blog.post_date})`);
  } else {
    console.log('\nBlog: not found');
  }
}

function printIntelCard(card: IntelCard, username: string): void {
  console.log('═══════════════════════════════════════');
  console.log(`HIRING SIGNAL ON HN: @${username}`);
  console.log('═══════════════════════════════════════');
  if (card.raw_hn_comment) {
    console.log(`Comment: "${card.raw_hn_comment.slice(0, 200)}"`);
    console.log(`→ https://news.ycombinator.com/item?id=${card.hn_comment_id}`);
  }
  console.log();
  console.log(`COMPANY: ${card.company_name} (YC ${card.company_batch || '??'})`);
  console.log(`Website: ${card.company_url} | Headcount: ~${card.headcount_estimate}`);
  console.log();
  console.log('WHAT THEY DO');
  console.log(`  ${card.what_they_do}`);
  console.log();
  if (card.careers_url) {
    console.log(`CAREERS: ${card.careers_url}`);
    console.log(`  Open roles: ${card.open_roles_count} | ATS: ${card.ats_detected}`);
    for (const [dept, count] of Object.entries(card.open_roles_breakdown)) {
      console.log(`    ${dept}: ${count}`);
    }
  }
  console.log();
  console.log(`SALES HISTORY: ${card.sales_hire_count} prior sales hires`);
  console.log();
  console.log(`OPPORTUNITY SCORE: ${card.opportunity_score}/10${card.opportunity_score >= 8 ? ' 🔥' : ''}`);
  console.log(`  ${card.suggested_angle}`);
  console.log('═══════════════════════════════════════\n');
}
