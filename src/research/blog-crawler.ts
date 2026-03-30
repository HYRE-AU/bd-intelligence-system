import { chromium } from 'playwright';
import type { BlogResult } from '../types';

const BLOG_PATHS = ['/blog', '/news', '/updates', '/posts'];
const FLAG_KEYWORDS = ['raise', 'funding', 'team', 'hiring', 'launch'];
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

// Browser-context scripts (avoid DOM type errors in Node TS)
const FIND_POST_LINK_SCRIPT = `(flagKws) => {
  const selectors = [
    'article a', 'a[href*="/blog/"]', 'a[href*="/news/"]',
    'a[href*="/post"]', '.post a', '.entry a', 'h2 a', 'h3 a',
  ];
  let bestLink = null;
  for (const sel of selectors) {
    const links = document.querySelectorAll(sel);
    if (links.length > 0) { bestLink = links[0]; break; }
  }
  if (!bestLink) return null;
  const postTitle = bestLink.textContent?.trim() || '';
  const postUrl = bestLink.href || '';
  return { postTitle, postUrl };
}`;

const EXTRACT_POST_CONTENT_SCRIPT = `() => {
  const article = document.querySelector('article')
    || document.querySelector('[class*="post-content"]')
    || document.querySelector('[class*="entry-content"]')
    || document.querySelector('[class*="blog-content"]')
    || document.querySelector('main');
  const text = article?.textContent || document.body?.textContent || '';
  const excerpt = text.replace(/\\s+/g, ' ').trim().slice(0, 500);
  const timeEl = document.querySelector('time');
  const dateStr = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';
  return { excerpt, dateStr };
}`;

/**
 * Crawl company blog for most recent post in last 60 days.
 * Tries /blog, /news, /updates, /posts on the company domain.
 */
export async function crawlBlog(
  companyUrl: string
): Promise<BlogResult | null> {
  const baseUrl = companyUrl.replace(/\/+$/, '');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    for (const blogPath of BLOG_PATHS) {
      const url = `${baseUrl}${blogPath}`;
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });
        if (!response || response.status() >= 400) continue;

        await page.waitForTimeout(1000 + Math.random() * 1000);

        // Find the most recent blog post link
        const findPostFn = new Function(`return (${FIND_POST_LINK_SCRIPT})`)();
        const postData = await page.evaluate(findPostFn, FLAG_KEYWORDS) as {
          postTitle: string;
          postUrl: string;
        } | null;

        if (!postData || !postData.postUrl) continue;

        // Navigate to the post and extract content
        await page.goto(postData.postUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });
        await page.waitForTimeout(1000 + Math.random() * 1000);

        const extractFn = new Function(`return (${EXTRACT_POST_CONTENT_SCRIPT})`)();
        const postContent = await page.evaluate(extractFn) as {
          excerpt: string;
          dateStr: string;
        };

        // Check if post is within 60 days
        const postDate = postContent.dateStr
          ? new Date(postContent.dateStr)
          : null;
        if (postDate) {
          const age = Date.now() - postDate.getTime();
          if (age > SIXTY_DAYS_MS) continue;
        }

        return {
          post_title: postData.postTitle,
          post_excerpt: postContent.excerpt,
          post_url: postData.postUrl,
          post_date: postContent.dateStr || '',
        };
      } catch {
        continue;
      }
    }

    return null;
  } finally {
    await browser.close();
  }
}
