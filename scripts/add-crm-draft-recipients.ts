/**
 * A CRM email draft can go to someone other than the record's Person: when
 * the thread hands us to a different point of contact, the draft is To the new
 * contact with the Person who referred us in Cc (src/lib/crm/draftRecipients.ts).
 *
 * Run with:  bun run scripts/add-crm-draft-recipients.ts
 *
 * - crm_drafts.to_email — the To when it is not the Person; NULL = the Person.
 * - crm_drafts.cc_emails — jsonb string[] copied on the send; NULL = none.
 *
 * Additive and idempotent: re-running changes nothing. Run it before the
 * code that reads these columns is deployed.
 */
import { Client } from "pg";

const DDL = `
ALTER TABLE crm_drafts ADD COLUMN IF NOT EXISTS to_email text;
ALTER TABLE crm_drafts ADD COLUMN IF NOT EXISTS cc_emails jsonb;
`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
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
    console.log("CRM draft recipient columns are in place.");
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
