import "server-only";

import { requestFirecrawl } from "./transport";

export async function verifyFirecrawlCredentials(credentials: Record<string, string>): Promise<void> {
  await requestFirecrawl("/v2/team/credit-usage", credentials.apiKey, { timeoutMs: 10_000 });
}
