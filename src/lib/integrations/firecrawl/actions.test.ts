import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { getIntegrationAction } from "../catalog";
import { getIntegrationActionHandler } from "../server/registry";
import type { IntegrationActionContext } from "../server/types";
import { verifyIntegrationCredentials } from "../verification";
import { PermanentRunError, RetryableRunError } from "@/lib/grid/runners/types";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function fetchResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  const spy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } }));
  spies.push(spy);
  return spy;
}

function context(actionKey: string, inputs: Record<string, unknown>, outputKeys?: string[]): IntegrationActionContext {
  const action = getIntegrationAction("firecrawl", actionKey);
  if (!action) throw new Error(`Action not registered: ${actionKey}`);
  const keys = outputKeys ?? action.outputs.map((output) => output.key);
  return {
    action, inputs, credentials: { apiKey: "fc-fictional-key" }, connectionId: "fictional-org-connection", timeoutMs: 30_000,
    config: {
      integrationKey: "firecrawl", actionKey, handlerKey: action.handlerKey, inputs: {},
      outputs: Object.fromEntries(keys.map((key) => [key, `mapped_${key}`])),
      connectionId: "fictional-org-connection",
    },
  };
}

async function run(ctx: IntegrationActionContext) {
  const handler = getIntegrationActionHandler(ctx.action.handlerKey);
  if (!handler) throw new Error("Handler not registered");
  const result = await handler(ctx);
  if ("pending" in result) throw new Error("Firecrawl must not poll");
  return result;
}

function sentBody(fetch: ReturnType<typeof fetchResponse>) {
  return JSON.parse(String(fetch.mock.calls[0][1]?.body));
}

const page = {
  markdown: "# Example Inc\n\nWe make fictional widgets.",
  metadata: { title: "Example Inc", description: "Fictional widgets", url: "https://www.example.com/", sourceURL: "https://example.com", statusCode: 200, creditsUsed: 1 },
};

describe("Firecrawl table actions", () => {
  test("scrapes a domain as Markdown only when no summary output is mapped", async () => {
    const fetch = fetchResponse(JSON.stringify({ success: true, data: page }));
    const result = await run(context("scrape-website", { url: "example.com" }, ["markdown", "title", "finalUrl", "statusCode", "creditsUsed"]));
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", headers: { Authorization: "Bearer fc-fictional-key" } });
    expect(sentBody(fetch)).toEqual({ url: "https://example.com/", formats: ["markdown"], onlyMainContent: true, timeout: 28_000, origin: "agentsdr" });
    expect(result.outputs).toEqual({ mapped_markdown: page.markdown, mapped_title: "Example Inc", mapped_finalUrl: "https://www.example.com/", mapped_statusCode: 200, mapped_creditsUsed: 1 });
    expect(result.outcome).toBe("hit");
    expect(result.costCents).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("fc-fictional-key");
  });

  test("keeps the path of a full URL", async () => {
    const fetch = fetchResponse(JSON.stringify({ success: true, data: page }));
    await run(context("scrape-website", { url: "https://example.com/pricing?plan=team" }, ["markdown"]));
    expect(sentBody(fetch).url).toBe("https://example.com/pricing?plan=team");
  });

  test("requests and maps the JSON summary when a summary output is mapped", async () => {
    const json = { companyName: "Example Inc", description: "Fictional widgets for testing.", products: ["Widget"], pricingModel: "Per seat", hiringSignals: "Hiring engineers" };
    const fetch = fetchResponse(JSON.stringify({ success: true, data: { ...page, json, metadata: { ...page.metadata, creditsUsed: 5 } } }));
    const result = await run(context("scrape-website", { url: "example.com" }));
    const formats = sentBody(fetch).formats;
    expect(formats[0]).toBe("markdown");
    expect(formats[1]).toMatchObject({ type: "json", schema: { type: "object" } });
    expect(result.outputs).toMatchObject({
      mapped_summary: json, mapped_companyName: "Example Inc", mapped_companyDescription: json.description,
      mapped_products: ["Widget"], mapped_pricingModel: "Per seat", mapped_hiringSignals: "Hiring engineers", mapped_creditsUsed: 5,
    });
  });

  test("requests the JSON summary for a response pointer under /json", async () => {
    const fetch = fetchResponse(JSON.stringify({ success: true, data: { ...page, json: { pricingModel: "Free" } } }));
    const ctx = context("scrape-website", { url: "example.com" }, []);
    ctx.config.outputs = { "response:/json/pricingModel": "pricing" };
    const result = await run(ctx);
    expect(sentBody(fetch).formats).toHaveLength(2);
    expect(result.outputs).toEqual({ pricing: "Free" });
  });

  test("reports a website that answered with an error status as a miss", async () => {
    fetchResponse(JSON.stringify({ success: true, data: { markdown: "Not Found", metadata: { statusCode: 404, creditsUsed: 1 } } }));
    const result = await run(context("scrape-website", { url: "example.com/missing" }));
    expect(result.outcome).toBe("miss");
    expect(result.value).toBe("Not found");
  });

  test("searches with defaults and maps title, url and snippet", async () => {
    const web = [
      { url: "https://example.com/news", title: "Example Inc raises a fictional round", description: "A fictional funding story.", position: 1 },
      { url: "https://example.org/jobs", title: "Example Inc is hiring", description: "Fictional job posts.", position: 2 },
    ];
    const fetch = fetchResponse(JSON.stringify({ success: true, data: { web }, creditsUsed: 2 }));
    const result = await run(context("search-web", { query: "  Example Inc funding " }));
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.firecrawl.dev/v2/search");
    expect(sentBody(fetch)).toEqual({ query: "Example Inc funding", limit: 5, timeout: 28_000, origin: "agentsdr" });
    expect(result.outputs).toMatchObject({
      mapped_results: [
        { title: web[0].title, url: web[0].url, snippet: web[0].description },
        { title: web[1].title, url: web[1].url, snippet: web[1].description },
      ],
      mapped_resultCount: 2, mapped_topTitle: web[0].title, mapped_topUrl: web[0].url, mapped_topSnippet: web[0].description, mapped_creditsUsed: 2,
    });
    expect(result.outcome).toBe("hit");
  });

  test("includes page Markdown only when asked", async () => {
    const fetch = fetchResponse(JSON.stringify({ success: true, data: { web: [{ url: "https://example.com/", title: "Example", description: "Snippet", markdown: "# Example" }] } }));
    const result = await run(context("search-web", { query: "example", limit: 1, includeMarkdown: true }));
    expect(sentBody(fetch)).toMatchObject({ limit: 1, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } });
    expect(result.outputs?.mapped_results).toEqual([{ title: "Example", url: "https://example.com/", snippet: "Snippet", markdown: "# Example" }]);
    expect(result.outputs?.mapped_creditsUsed).toBeNull();
  });

  test("returns a miss for an empty result list", async () => {
    fetchResponse(JSON.stringify({ success: true, data: { web: [] }, creditsUsed: 1 }));
    const result = await run(context("search-web", { query: "nothing matches this" }));
    expect(result.outcome).toBe("miss");
    expect(result.outputs?.mapped_resultCount).toBe(0);
  });

  test.each([
    ["scrape-website", { url: "ftp://example.com" }],
    ["scrape-website", { url: "https://user:password@example.com" }],
    ["scrape-website", { url: "localhost" }],
    ["scrape-website", { url: "" }],
    ["search-web", { query: "" }],
    ["search-web", { query: "x".repeat(501) }],
    ["search-web", { query: "test", limit: 0 }],
    ["search-web", { query: "test", limit: 11 }],
    ["search-web", { query: "test", limit: 2.5 }],
  ] as const)("rejects invalid %s input before spending", async (action, inputs) => {
    const fetch = fetchResponse("{}");
    await expect(run(context(action, inputs))).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([400, 401, 402, 403, 408, 500, 302])("fails without retrying for HTTP %i", async (status) => {
    const fetch = fetchResponse(JSON.stringify({ success: false, error: "Something went wrong" }), status);
    await expect(run(context("search-web", { query: "test" }))).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("passes Firecrawl's own error message through, trimmed", async () => {
    fetchResponse(JSON.stringify({ success: false, code: "SCRAPE_DNS_RESOLUTION_ERROR", error: "DNS resolution failed for hostname \"missing.example\"." }), 200);
    await expect(run(context("scrape-website", { url: "missing.example" }))).rejects.toThrow("DNS resolution failed");
  });

  test("lets the queue retry a rate limit, which uses no credits", async () => {
    fetchResponse(JSON.stringify({ success: false, error: "Rate limit exceeded" }), 429);
    await expect(run(context("search-web", { query: "test" }))).rejects.toBeInstanceOf(RetryableRunError);
  });

  test("turns network failures into permanent errors so the queue cannot replay a paid call", async () => {
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("sensitive transport details"));
    spies.push(fetch);
    const error = await run(context("scrape-website", { url: "example.com" })).catch((caught) => caught);
    expect(error).toBeInstanceOf(PermanentRunError);
    expect(String(error)).not.toContain("sensitive");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("does not spend if the caller has already cancelled the job", async () => {
    const fetch = fetchResponse("{}");
    const ctx = context("search-web", { query: "test" });
    ctx.signal = AbortSignal.abort();
    await expect(run(ctx)).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([true, false])("bounds response bytes, with content-length=%s", async (withHeader) => {
    const body = JSON.stringify({ success: true, data: { markdown: "x".repeat(5 * 1024 * 1024) } });
    fetchResponse(body, 200, withHeader ? { "content-length": String(body.length) } : {});
    await expect(run(context("scrape-website", { url: "example.com" }))).rejects.toBeInstanceOf(PermanentRunError);
  });

  test.each(["not JSON", "null", '{"success":true}', '{"success":true,"data":{"web":"nope"}}'])("rejects malformed successful responses: %s", async (body) => {
    fetchResponse(body);
    await expect(run(context("search-web", { query: "test" }))).rejects.toBeInstanceOf(PermanentRunError);
  });

  test("uses each connection's own key", async () => {
    const fetch = fetchResponse(JSON.stringify({ success: true, data: { web: [] } }));
    const first = context("search-web", { query: "test" });
    first.credentials = { apiKey: "fc-org-a" };
    await run(first);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { web: [] } })));
    const second = context("search-web", { query: "test" });
    second.credentials = { apiKey: "fc-org-b" };
    await run(second);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer fc-org-a", "Bearer fc-org-b"]);
  });

  test.each(["", "Bearer fc-fictional-key", "fc-fictional\r\nheader", "fc-ключ"])("rejects an invalid key format before making a request", async (key) => {
    const fetch = fetchResponse("{}");
    await expect(verifyIntegrationCredentials("firecrawl", { apiKey: key })).rejects.toBeInstanceOf(PermanentRunError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("verifies credentials through the free credit-usage endpoint and discards account data", async () => {
    const fetch = fetchResponse('{"success":true,"data":{"remainingCredits":100}}');
    expect(await verifyIntegrationCredentials("firecrawl", { apiKey: "fc-fictional-key" })).toBeUndefined();
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
  });

  test("does not accept a credit-usage answer that reports a failure", async () => {
    fetchResponse('{"success":false,"error":"Unknown team"}');
    await expect(verifyIntegrationCredentials("firecrawl", { apiKey: "fc-fictional-key" })).rejects.toBeInstanceOf(PermanentRunError);
  });

  test("rejects a key Firecrawl does not accept", async () => {
    fetchResponse('{"success":false,"error":"Unauthorized: Invalid token"}', 401);
    await expect(verifyIntegrationCredentials("firecrawl", { apiKey: "fc-wrong" })).rejects.toThrow("The API key was rejected.");
  });
});
