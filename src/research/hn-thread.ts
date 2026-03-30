import type { HNThreadResult } from '../types';

const HN_ITEMS_URL = 'https://hn.algolia.com/api/v1/items';

const RELEVANT_KEYWORDS = ['hiring', 'team', 'sales', 'raise', 'product'];

interface HNItem {
  author: string;
  text: string | null;
  points: number | null;
  children: HNItem[];
}

/**
 * Fetch full HN thread, extract author replies and relevant comments.
 * Returns top 5 most relevant comments by score.
 */
export async function extractHNThread(
  storyId: string,
  storyAuthor: string
): Promise<HNThreadResult | null> {
  const res = await fetch(`${HN_ITEMS_URL}/${storyId}`);
  if (!res.ok) return null;

  const data = (await res.json()) as HNItem;
  const authorReplies: string[] = [];
  const relevantComments: { text: string; score: number }[] = [];

  function walkComments(items: HNItem[]): void {
    for (const item of items) {
      const text = item.text || '';
      if (!text) {
        walkComments(item.children || []);
        continue;
      }

      const textLower = text.toLowerCase();

      // Author replies
      if (item.author === storyAuthor) {
        authorReplies.push(stripHtml(text));
      }

      // Relevant comments mentioning key terms
      const matchCount = RELEVANT_KEYWORDS.filter((kw) =>
        textLower.includes(kw)
      ).length;
      if (matchCount > 0) {
        relevantComments.push({
          text: stripHtml(text),
          score: (item.points || 0) + matchCount * 10,
        });
      }

      walkComments(item.children || []);
    }
  }

  walkComments(data.children || []);

  // Sort by relevance score desc, take top 5
  relevantComments.sort((a, b) => b.score - a.score);

  return {
    author_replies: authorReplies,
    relevant_comments: relevantComments.slice(0, 5).map((c) => c.text),
  };
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
