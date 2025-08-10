import 'dotenv/config';
import { createClient } from 'redis';

async function main() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = createClient({ url: redisUrl });
  await client.connect();
  const msg = {
    type: 'upsert',
    offerId: 'offer_demo_1_2025-10-12_2025-10-14',
    propertyId: 'prop_demo_1',
    changed: ['price', 'inventory'],
    at: new Date().toISOString()
  };
  await client.publish('offers:delta', JSON.stringify(msg));
  console.log('Published delta:', msg);
  await client.quit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
