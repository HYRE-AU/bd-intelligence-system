import { chromium } from 'playwright';
import type { CareersResult } from '../types';

const CAREERS_PATHS = ['/careers', '/jobs', '/join', '/work-with-us'];

const ATS_PATTERNS: Record<string, RegExp> = {
  Lever: /lever\.co/i,
  Greenhouse: /greenhouse\.io|boards\.greenhouse/i,
  Workable: /workable\.com|apply\.workable/i,
  Ashby: /ashbyhq\.com/i,
};

const DEPT_KEYWORDS: Record<string, string[]> = {
  engineering: [
    'engineer', 'developer', 'software', 'frontend', 'backend',
    'fullstack', 'full-stack', 'devops', 'sre', 'infrastructure',
    'platform', 'machine learning', 'ml ', 'data engineer', 'mobile',
    'ios', 'android', 'qa', 'security',
  ],
  sales: [
    'sales', 'account executive', 'sdr', 'bdr', 'business development',
    'gtm', 'go-to-market', 'revenue',
  ],
  ops: [
    'operations', 'ops', 'office manager', 'executive assistant',
    'people', 'hr', 'finance', 'legal', 'recruiting', 'talent',
  ],
  design: [
    'design', 'ux', 'ui', 'product design', 'graphic', 'brand', 'creative',
  ],
  data: [
    'data scientist', 'data analyst', 'analytics', 'bi ',
    'business intelligence',
  ],
};

function classifyRole(title: string): string {
  const lower = title.toLowerCase();
  for (const [dept, keywords] of Object.entries(DEPT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return dept;
    }
  }
  return 'other';
}

// Browser-context scripts
const FIND_CAREERS_LINK_SCRIPT = `(paths) => {
  const allLinks = document.querySelectorAll('a[href]');
  for (const link of allLinks) {
    const href = link.href.toLowerCase();
    for (const p of paths) {
      if (href.includes(p)) return link.href;
    }
  }
  return null;
}`;

const EXTRACT_ROLES_SCRIPT = `() => {
  const titles = [];
  const selectors = [
    '[class*="job"] h3', '[class*="job"] h4',
    '[class*="position"] h3', '[class*="position"] h4',
    '[class*="opening"] h3', '[class*="opening"] a',
    '[class*="role"] h3', '[class*="role"] a',
    'li h3', 'li h4', 'tr td:first-child',
    '.posting-title', '[data-qa="posting-name"]',
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      els.forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length > 3 && text.length < 100) titles.push(text);
      });
      if (titles.length > 0) break;
    }
  }
  if (titles.length === 0) {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const href = link.href || '';
      const text = link.textContent?.trim() || '';
      if (text.length > 5 && text.length < 100 &&
          (href.includes('/job') || href.includes('/position') || href.includes('/opening'))) {
        titles.push(text);
      }
    }
  }
  return titles;
}`;

/**
 * Crawl company careers page using Playwright.
 * Detects ATS, scrapes open roles, categorises by department.
 */
export async function crawlCareersPage(
  companyUrl: string
): Promise<CareersResult | null> {
  const baseUrl = companyUrl.replace(/\/+$/, '');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Step 1: Load homepage and find careers link
    let careersUrl: string | null = null;

    try {
      await page.goto(baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      await page.waitForTimeout(1000 + Math.random() * 1000);

      const findLinkFn = new Function(`return (${FIND_CAREERS_LINK_SCRIPT})`)();
      careersUrl = await page.evaluate(findLinkFn, CAREERS_PATHS) as string | null;
    } catch {
      // Homepage failed, try direct paths
    }

    // If no link found on homepage, try direct paths
    if (!careersUrl) {
      for (const careerPath of CAREERS_PATHS) {
        const tryUrl = `${baseUrl}${careerPath}`;
        try {
          const resp = await page.goto(tryUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 15_000,
          });
          if (resp && resp.status() < 400) {
            careersUrl = tryUrl;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!careersUrl) return null;

    // Step 2: Navigate to careers page
    if (page.url() !== careersUrl) {
      await page.goto(careersUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      await page.waitForTimeout(1000 + Math.random() * 1000);
    }

    // Step 3: Detect ATS from page content and iframes
    const pageContent = await page.content();
    let atsDetected = 'none';

    for (const [name, pattern] of Object.entries(ATS_PATTERNS)) {
      if (pattern.test(pageContent) || pattern.test(page.url())) {
        atsDetected = name;
        break;
      }
    }

    if (atsDetected === 'none' && /docs\.google\.com\/forms/i.test(pageContent)) {
      atsDetected = 'none (google form)';
    }

    // Step 4: Extract role titles
    const extractRolesFn = new Function(`return (${EXTRACT_ROLES_SCRIPT})`)();
    const roleTitles = await page.evaluate(extractRolesFn) as string[];

    // Step 5: Classify roles by department
    const roles = roleTitles.map((title) => ({
      title,
      department: classifyRole(title),
    }));

    const roleCounts: Record<string, number> = {};
    for (const role of roles) {
      roleCounts[role.department] = (roleCounts[role.department] || 0) + 1;
    }

    return {
      careers_url: careersUrl,
      roles,
      ats_detected: atsDetected,
      role_counts_by_dept: roleCounts,
    };
  } finally {
    await browser.close();
  }
}
