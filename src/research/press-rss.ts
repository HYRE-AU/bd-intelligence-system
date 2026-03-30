import Parser from 'rss-parser';
import type { PressResult } from '../types';

const RSS_FEEDS = [
  { url: 'https://techcrunch.com/feed/', source: 'TechCrunch' },
  { url: 'https://axios.com/feeds/feed.rss', source: 'Axios' },
];

const QUOTE_KEYWORDS = [
  'will use',
  'plans to',
  'to expand',
  'to hire',
  'to build',
];

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Search TechCrunch + Axios RSS feeds for mentions of companyName
 * in the last 30 days. Extract headlines and key quotes.
 */
export async function searchPressRSS(
  companyName: string
): Promise<PressResult[]> {
  const parser = new Parser();
  const results: PressResult[] = [];
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const companyLower = companyName.toLowerCase();

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items || []) {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        if (pubDate < cutoff) continue;

        const title = item.title || '';
        const description = item.contentSnippet || item.content || '';
        const combined = `${title} ${description}`.toLowerCase();

        if (!combined.includes(companyLower)) continue;

        // Extract key quotes: sentences containing signal keywords
        const sentences = description.split(/[.!?]+/).map((s) => s.trim());
        const quotes = sentences.filter((s) => {
          const sLower = s.toLowerCase();
          return QUOTE_KEYWORDS.some((kw) => sLower.includes(kw));
        });

        results.push({
          source: feed.source,
          headline: title,
          quotes,
          url: item.link || '',
          published_at: item.pubDate || '',
        });
      }
    } catch (err) {
      console.error(`Failed to parse ${feed.source} RSS:`, err);
    }
  }

  return results;
}
