import { Resend } from 'resend';
import { getUnsentJobListings, markJobListingsAlerted } from '../db/supabase';

export async function sendDigestEmail(): Promise<void> {
  const listings = await getUnsentJobListings();

  if (listings.length === 0) {
    console.log('No unsent listings — skipping digest email');
    return;
  }

  console.log(`Sending digest with ${listings.length} new roles`);

  const now = new Date();
  const dayDate = now.toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const subject = `🚀 ${listings.length} new sales roles on YC — ${dayDate}`;

  // Plain text body, one block per role, sorted by posted_at desc (already sorted by query)
  const body = listings
    .map((l) => {
      const postedAgo = formatTimeAgo(l.posted_at);
      const companySlug = l.company_url
        ? l.company_url
        : `https://www.ycombinator.com/companies/${l.company_name.toLowerCase().replace(/\s+/g, '-')}`;
      return [
        '────────────────────────────────────',
        `${l.company_name} (${l.company_batch || '??'}) — ${l.role_title}`,
        `Posted: ${postedAgo}`,
        `→ YC profile: ${companySlug}`,
        `→ Job listing: ${l.role_url}`,
        `Matched keyword: ${l.matched_keyword}`,
      ].join('\n');
    })
    .join('\n\n');

  const fullBody = `${body}\n\n────────────────────────────────────\n${listings.length} total new roles found.\n`;

  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const toEmail = process.env.RESEND_TO_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;

  if (!fromEmail || !toEmail || !apiKey) {
    throw new Error('Missing RESEND_FROM_EMAIL, RESEND_TO_EMAIL, or RESEND_API_KEY');
  }

  const resend = new Resend(apiKey);

  await resend.emails.send({
    from: fromEmail,
    to: toEmail,
    subject,
    text: fullBody,
  });

  console.log(`Digest email sent: "${subject}"`);

  // Mark all sent listings as alerted
  const ids = listings.map((l) => l.id);
  await markJobListingsAlerted(ids);
  console.log(`Marked ${ids.length} listings as alerted`);
}

function formatTimeAgo(dateStr: string): string {
  const posted = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - posted.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${diffHours} hours ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}
