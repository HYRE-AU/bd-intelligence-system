import 'dotenv/config';
import { sendDigestEmail } from '../src/email/digest';

(async () => {
  await sendDigestEmail();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
