import OpenAI from 'openai';
import type { IntelCard, ResearchData } from '../types';

/**
 * Synthesise all research data into a structured IntelCard using GPT-4o.
 * Max context ~4k tokens input, max_tokens: 800 output.
 */
export async function synthesiseIntelCard(
  research: ResearchData,
  context: {
    hn_story_id: string | null;
    hn_comment_id: string | null;
    pipeline: 'funding' | 'hn_signal';
    company_name: string;
    company_url: string;
    raw_hn_comment: string | null;
    do_not_contact: boolean;
  }
): Promise<IntelCard> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  const openai = new OpenAI({ apiKey });

  const prompt = buildPrompt(research, context);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a BD intelligence analyst for Perfectly, a YC W26 AI recruiting agency.
You generate structured intel cards about YC startups that may need sales hiring help.
Always respond with valid JSON matching the exact schema provided. No markdown, no explanation — just JSON.`,
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: 800,
    temperature: 0.3,
  });

  const raw = completion.choices[0]?.message?.content?.trim() || '';

  let parsed: SynthesisOutput;
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    parsed = JSON.parse(cleaned) as SynthesisOutput;
  } catch (err) {
    console.error('GPT-4o returned invalid JSON:', raw);
    throw new Error('Synthesis failed: invalid JSON from GPT-4o');
  }

  return {
    hn_story_id: context.hn_story_id,
    hn_comment_id: context.hn_comment_id,
    pipeline: context.pipeline,
    company_name: context.company_name,
    company_batch: research.ycDirectory?.batch || '',
    company_url: context.company_url,
    founder_names: research.ycDirectory?.founders || [],
    founder_backgrounds: parsed.founder_backgrounds || [],
    what_they_do: parsed.what_they_do || '',
    funding_stage: parsed.funding_stage || '',
    funding_amount: parsed.funding_amount || '',
    funding_announced_at: parsed.funding_announced_at || null,
    use_of_funds: parsed.use_of_funds || '',
    headcount_estimate: research.ycDirectory?.team_size || parsed.headcount_estimate || 0,
    careers_url: research.careers?.careers_url || null,
    open_roles_count: research.careers?.roles.length || 0,
    open_roles_breakdown: research.careers?.role_counts_by_dept || {},
    ats_detected: research.careers?.ats_detected || 'unknown',
    sales_hire_count: parsed.sales_hire_count ?? 0,
    opportunity_score: parsed.opportunity_score ?? 5,
    suggested_angle: parsed.suggested_angle || '',
    raw_hn_comment: context.raw_hn_comment,
    do_not_contact: context.do_not_contact,
  };
}

interface SynthesisOutput {
  what_they_do: string;
  funding_stage: string;
  funding_amount: string;
  funding_announced_at: string | null;
  use_of_funds: string;
  headcount_estimate: number;
  founder_backgrounds: { name: string; prior_companies: string; relevant_signal: string }[];
  sales_hire_count: number;
  has_recruiting_background: boolean;
  opportunity_score: number;
  score_reasoning: string;
  suggested_angle: string;
}

function buildPrompt(
  research: ResearchData,
  context: {
    company_name: string;
    company_url: string;
    do_not_contact: boolean;
    raw_hn_comment: string | null;
  }
): string {
  const sections: string[] = [];

  sections.push(`COMPANY: ${context.company_name}`);
  sections.push(`WEBSITE: ${context.company_url}`);

  if (research.ycDirectory) {
    sections.push(`\nYC DIRECTORY DATA:
- Batch: ${research.ycDirectory.batch}
- One-liner: ${research.ycDirectory.one_liner}
- Team size: ${research.ycDirectory.team_size}
- Founders: ${research.ycDirectory.founders.join(', ')}`);
  }

  if (research.careers) {
    const roleSummary = Object.entries(research.careers.role_counts_by_dept)
      .map(([dept, count]) => `  ${dept}: ${count}`)
      .join('\n');
    sections.push(`\nCAREERS PAGE: ${research.careers.careers_url}
- ATS: ${research.careers.ats_detected}
- Open roles (${research.careers.roles.length} total):
${roleSummary}
- Role titles: ${research.careers.roles.map((r) => r.title).join(', ')}`);
  }

  if (research.press.length > 0) {
    const pressText = research.press
      .map(
        (p) =>
          `[${p.source}] "${p.headline}" (${p.published_at})\nQuotes: ${p.quotes.length > 0 ? p.quotes.join(' | ') : 'none'}\nURL: ${p.url}`
      )
      .join('\n\n');
    sections.push(`\nPRESS COVERAGE:\n${pressText}`);
  }

  if (research.hnThread) {
    if (research.hnThread.author_replies.length > 0) {
      sections.push(
        `\nFOUNDER HN REPLIES:\n${research.hnThread.author_replies.join('\n---\n')}`
      );
    }
    if (research.hnThread.relevant_comments.length > 0) {
      sections.push(
        `\nRELEVANT HN COMMENTS:\n${research.hnThread.relevant_comments.join('\n---\n')}`
      );
    }
  }

  if (research.blog) {
    sections.push(`\nBLOG POST: "${research.blog.post_title}" (${research.blog.post_date})
URL: ${research.blog.post_url}
Excerpt: ${research.blog.post_excerpt}`);
  }

  if (context.raw_hn_comment) {
    sections.push(`\nORIGINAL HN COMMENT (trigger signal):\n"${context.raw_hn_comment}"`);
  }

  sections.push(`\nSCORING RUBRIC (apply this exactly):
+3 if raise was < 14 days ago
+2 if no prior sales hires detected
+2 if founders have no recruiting background
+1 if no ATS detected
+1 if sales role currently posted
-1 if headcount > 50
-2 if already a Perfectly client (do_not_contact = ${context.do_not_contact})
Start from base score of 0, apply all applicable modifiers, clamp to 1-10.`);

  sections.push(`\nRESPOND WITH THIS EXACT JSON SCHEMA:
{
  "what_they_do": "2 sentences max describing what the company does",
  "funding_stage": "e.g. Seed, Series A, Series B",
  "funding_amount": "e.g. $3.2M",
  "funding_announced_at": "ISO date string or null",
  "use_of_funds": "extracted from press/blog/HN quotes if available",
  "headcount_estimate": 0,
  "founder_backgrounds": [
    {"name": "Full Name", "prior_companies": "ex-Company1, Company2", "relevant_signal": "one line about recruiting/sales relevance"}
  ],
  "sales_hire_count": 0,
  "has_recruiting_background": false,
  "opportunity_score": 7,
  "score_reasoning": "brief explanation of score using rubric",
  "suggested_angle": "1-2 sentences, MUST reference their own words from press/HN/blog if available. Specific > generic."
}`);

  return sections.join('\n');
}
