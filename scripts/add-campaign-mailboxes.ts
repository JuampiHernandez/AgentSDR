/**
 * An email campaign can send from chosen mailboxes instead of all of them.
 *
 * Run with:  bun run scripts/add-campaign-mailboxes.ts
 *
 * - outreach_campaigns.mailbox_ids (uuid[]): the mailboxes a campaign's new
 *   leads may be given (src/lib/outreach/campaignMailboxes.ts). NULL means
 *   every connected mailbox, which is what every campaign did before.
 *
 * Additive and idempotent: re-running changes nothing, and existing campaigns
 * stay on all mailboxes. Run it before the code that reads the column is
 * deployed. Keep in sync with src/lib/outreach/schema.ts.
 */
import { Client } from "pg";

const DDL = `
ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS mailbox_ids uuid[];
`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set: check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '2min'");
    await client.query("BEGIN");
    await client.query(DDL);
    await client.query("COMMIT");
    console.log("outreach_campaigns.mailbox_ids is in place.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
