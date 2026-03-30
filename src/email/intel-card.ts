import { Resend } from 'resend';
import type { IntelCard } from '../types';
import fs from 'fs';
import path from 'path';

/**
 * Send an intel card email immediately.
 * Pipeline 2 subject: "📊 New funding signal: [Company] (YC [Batch]) — [Score]/10"
 * Pipeline 3 subject: "💬 HN hiring signal: @[username] ([Company]) — [Score]/10"
 */
export async function sendIntelCardEmail(
  card: IntelCard,
  hnUsername?: string
): Promise<void> {
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const toEmail = process.env.RESEND_TO_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;

  if (!fromEmail || !toEmail || !apiKey) {
    throw new Error('Missing RESEND_FROM_EMAIL, RESEND_TO_EMAIL, or RESEND_API_KEY');
  }

  const subject =
    card.pipeline === 'funding'
      ? `📊 New funding signal: ${card.company_name} (YC ${card.company_batch}) — ${card.opportunity_score}/10`
      : `💬 HN hiring signal: @${hnUsername || 'unknown'} (${card.company_name}) — ${card.opportunity_score}/10`;

  const html = buildIntelCardHtml(card, hnUsername);

  const resend = new Resend(apiKey);
  await resend.emails.send({
    from: fromEmail,
    to: toEmail,
    subject,
    html,
  });

  console.log(`Intel card email sent: "${subject}"`);
}

function buildIntelCardHtml(card: IntelCard, hnUsername?: string): string {
  // Try to load template, fallback to inline
  let template: string;
  try {
    template = fs.readFileSync(
      path.join(__dirname, 'templates', 'intel-card.html'),
      'utf-8'
    );
  } catch {
    template = DEFAULT_TEMPLATE;
  }

  // Founder section
  const foundersHtml = card.founder_backgrounds
    .map(
      (f) =>
        `<tr><td style="padding:4px 0"><strong>${esc(f.name)}</strong> — ${esc(f.prior_companies)}<br/><span style="color:#666">→ ${esc(f.relevant_signal)}</span></td></tr>`
    )
    .join('');

  // Roles breakdown
  const rolesHtml = Object.entries(card.open_roles_breakdown)
    .map(([dept, count]) => {
      const isSales = dept === 'sales';
      return `<tr><td style="padding:2px 0">${isSales ? '🔥 ' : ''}${esc(dept)}: ${count}</td></tr>`;
    })
    .join('');

  // Signal-specific header
  const signalHeader =
    card.pipeline === 'hn_signal' && card.raw_hn_comment
      ? `<div style="background:#fffbe6;border-left:4px solid #f59e0b;padding:12px;margin-bottom:16px">
           <strong>HIRING SIGNAL ON HN: @${esc(hnUsername || '')}</strong><br/>
           <em>"${esc(card.raw_hn_comment)}"</em><br/>
           <a href="https://news.ycombinator.com/item?id=${card.hn_comment_id}">View on HN →</a>
         </div>`
      : '';

  const scoreEmoji = card.opportunity_score >= 8 ? ' 🔥' : card.opportunity_score >= 6 ? '' : '';

  const ycProfileUrl = `https://www.ycombinator.com/companies/${card.company_name.toLowerCase().replace(/\s+/g, '-')}`;

  const html = template
    .replace('{{SIGNAL_HEADER}}', signalHeader)
    .replace('{{COMPANY_NAME}}', esc(card.company_name))
    .replace('{{COMPANY_BATCH}}', esc(card.company_batch))
    .replace('{{FUNDING_STAGE}}', esc(card.funding_stage))
    .replace('{{FUNDING_AMOUNT}}', esc(card.funding_amount))
    .replace('{{COMPANY_URL}}', esc(card.company_url))
    .replace('{{HEADCOUNT}}', String(card.headcount_estimate))
    .replace('{{FOUNDERS_HTML}}', foundersHtml)
    .replace('{{WHAT_THEY_DO}}', esc(card.what_they_do))
    .replace('{{USE_OF_FUNDS}}', esc(card.use_of_funds))
    .replace('{{CAREERS_URL}}', card.careers_url ? esc(card.careers_url) : 'Not found')
    .replace('{{OPEN_ROLES_COUNT}}', String(card.open_roles_count))
    .replace('{{ROLES_BREAKDOWN_HTML}}', rolesHtml)
    .replace('{{ATS}}', esc(card.ats_detected))
    .replace('{{SALES_HIRE_COUNT}}', String(card.sales_hire_count))
    .replace('{{SCORE}}', String(card.opportunity_score))
    .replace('{{SCORE_EMOJI}}', scoreEmoji)
    .replace('{{SUGGESTED_ANGLE}}', esc(card.suggested_angle))
    .replace('{{YC_PROFILE_URL}}', ycProfileUrl);

  return html;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DEFAULT_TEMPLATE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a">
{{SIGNAL_HEADER}}
<div style="border:2px solid #333;padding:20px">
<h2 style="margin:0 0 16px">COMPANY INTEL: {{COMPANY_NAME}} (YC {{COMPANY_BATCH}})</h2>

<table style="width:100%;margin-bottom:16px">
<tr><td>Stage: {{FUNDING_STAGE}} {{FUNDING_AMOUNT}}</td></tr>
<tr><td>Website: <a href="{{COMPANY_URL}}">{{COMPANY_URL}}</a> | Headcount: ~{{HEADCOUNT}}</td></tr>
</table>

<h3 style="margin:16px 0 8px;border-top:1px solid #ddd;padding-top:12px">FOUNDERS</h3>
<table style="width:100%">{{FOUNDERS_HTML}}</table>

<h3 style="margin:16px 0 8px;border-top:1px solid #ddd;padding-top:12px">WHAT THEY DO</h3>
<p>{{WHAT_THEY_DO}}</p>

<h3 style="margin:16px 0 8px;border-top:1px solid #ddd;padding-top:12px">FUNDING CONTEXT</h3>
<p>{{USE_OF_FUNDS}}</p>

<h3 style="margin:16px 0 8px;border-top:1px solid #ddd;padding-top:12px">HIRING SIGNALS</h3>
<table style="width:100%">
<tr><td>Careers page: <a href="{{CAREERS_URL}}">{{CAREERS_URL}}</a></td></tr>
<tr><td>Open roles: {{OPEN_ROLES_COUNT}} total</td></tr>
{{ROLES_BREAKDOWN_HTML}}
<tr><td>ATS: {{ATS}}</td></tr>
</table>

<h3 style="margin:16px 0 8px;border-top:1px solid #ddd;padding-top:12px">SALES HIRING HISTORY</h3>
<p>Prior sales hires: {{SALES_HIRE_COUNT}}</p>

<div style="background:#f0fdf4;border:2px solid #22c55e;padding:16px;margin:16px 0;text-align:center">
<h2 style="margin:0">OPPORTUNITY SCORE: {{SCORE}}/10{{SCORE_EMOJI}}</h2>
<p style="margin:8px 0 0">{{SUGGESTED_ANGLE}}</p>
</div>

<div style="text-align:center;padding-top:12px;border-top:1px solid #ddd">
<a href="{{YC_PROFILE_URL}}">YC Profile</a>
</div>
</div>
</body>
</html>`;
