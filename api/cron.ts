import type { VercelRequest, VercelResponse } from '@vercel/node';
import { queueNewListings } from '../src/pipelines/yc-jobs';
import { runHNFundingPipeline } from '../src/pipelines/hn-funding';
import { runHNSignalsPipeline } from '../src/pipelines/hn-signals';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const pipeline = req.query.pipeline as string;

  try {
    switch (pipeline) {
      case 'yc-jobs': {
        console.log('Running Pipeline 1: YC Jobs scrape + digest');
        const matched = await queueNewListings();
        res.status(200).json({
          pipeline: 'yc-jobs',
          matched: matched.length,
        });
        break;
      }

      case 'hn-funding': {
        console.log('Running Pipeline 2: HN Funding Intelligence');
        const cards = await runHNFundingPipeline();
        res.status(200).json({
          pipeline: 'hn-funding',
          cards_generated: cards.length,
        });
        break;
      }

      case 'hn-signals': {
        console.log('Running Pipeline 3: HN Hiring Signal Monitor');
        const signalCards = await runHNSignalsPipeline();
        res.status(200).json({
          pipeline: 'hn-signals',
          cards_generated: signalCards.length,
        });
        break;
      }

      default:
        res.status(400).json({ error: `Unknown pipeline: ${pipeline}` });
    }
  } catch (err) {
    console.error(`Pipeline ${pipeline} failed:`, err);
    res.status(500).json({
      error: 'Pipeline failed',
      pipeline,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
