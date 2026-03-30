import * as cheerio from 'cheerio';
import type { BlogResult } from '../types';

const BLOG_PATHS = ['/blog', '/news', '/updates', '/posts'];
const FLAG_KEYWORDS = ['raise', 'funding', 'team', 'hiring', 'launch'];
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Crawl company blog for most recent post in last 60 days.
 * Tries /blog, /news, /updates, /posts on the company domain.
 * Uses fetch + cheerio (no browser needed).
 */
export async function crawlBlog(
  companyUrl: string
): Promise<BlogResult | null> {
  const baseUrl = companyUrl.replace(/\/+$/, '');

  for (const blogPath of BLOG_PATHS) {
    const url = `${baseUrl}${blogPath}`;
    const html = await fetchHtml(url);
    if (!html) continue;

    const $ = cheerio.load(html);

    // Find the most recent blog post link
    const selectors = [
      'article a[href]',
      'a[href*="/blog/"]',
      'a[href*="/news/"]',
      'a[href*="/post"]',
      '.post a[href]',
      '.entry a[href]',
      'h2 a[href]',
      'h3 a[href]',
    ];

    let postTitle = '';
    let postUrl = '';

    for (const sel of selectors) {
      const link = $(sel).first();
      if (link.length > 0) {
        postTitle = link.text().trim();
        const href = link.attr('href') || '';
        try {
          postUrl = new URL(href, url).href;
        } catch {
          postUrl = href.startsWith('/') ? `${baseUrl}${href}` : href;
        }
        break;
      }
    }

    if (!postUrl) continue;

    // Fetch the post page and extract content
    const postHtml = await fetchHtml(postUrl);
    if (!postHtml) continue;

    const $post = cheerio.load(postHtml);

    // Extract article body
    const articleEl =
      $post('article').first().length > 0
        ? $post('article').first()
        : $post('[class*="post-content"], [class*="entry-content"], [class*="blog-content"], main').first();

    const bodyText = (articleEl.length > 0 ? articleEl.text() : $post('body').text())
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);

    // Extract date
    const timeEl = $post('time').first();
    const dateStr =
      timeEl.attr('datetime') || timeEl.text().trim() || '';

    // Check if post is within 60 days
    if (dateStr) {
      const postDate = new Date(dateStr);
      if (!isNaN(postDate.getTime())) {
        const age = Date.now() - postDate.getTime();
        if (age > SIXTY_DAYS_MS) continue;
      }
    }

    return {
      post_title: postTitle,
      post_excerpt: bodyText,
      post_url: postUrl,
      post_date: dateStr,
    };
  }

  return null;
}
