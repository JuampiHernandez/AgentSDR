import "server-only";

import { responsePointerFromOutputKey } from "@/lib/grid/json-pointer";
import { PermanentRunError } from "@/lib/grid/runners/types";
import type { CellResult } from "@/lib/grid/types";
import { asRecord, mapConfiguredOutputs, truncate } from "../server/helpers";
import type { IntegrationActionContext, IntegrationActionHandlers } from "../server/types";
import { FIRECRAWL_SUMMARY_OUTPUT_KEYS } from "./definition";
import { firecrawlTimeout, requestFirecrawl } from "./transport";

const SUMMARY_PROMPT = "Summarize this company website for sales research: what the company does, its products, its pricing model and any hiring signals.";
const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    companyName: { type: "string" },
    description: { type: "string" },
    products: { type: "array", items: { type: "string" } },
    pricingModel: { type: "string" },
    hiringSignals: { type: "string" },
  },
};
const SUMMARY_KEYS = new Set<string>(FIRECRAWL_SUMMARY_OUTPUT_KEYS);

export function websiteUrl(value: unknown): string {
  const invalid = () => { throw new PermanentRunError("Website or URL: provide an http(s) website or domain such as example.com, without a username or password."); };
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return invalid();
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".")) return invalid();
    return url.toString();
  } catch {
    return invalid();
  }
}

function wantsSummary(outputs: Record<string, string>): boolean {
  return Object.keys(outputs).some((key) => SUMMARY_KEYS.has(key) || responsePointerFromOutputKey(key)?.startsWith("/json") === true);
}

function bodyTimeout(timeoutMs: number): number {
  return Math.max(1_000, firecrawlTimeout(timeoutMs) - 2_000);
}

function credits(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

async function scrapeWebsite(context: IntegrationActionContext): Promise<CellResult> {
  const { config, inputs, credentials, timeoutMs, signal } = context;
  const url = websiteUrl(inputs.url);
  const summary = wantsSummary(config.outputs);
  const formats: unknown[] = ["markdown"];
  if (summary) formats.push({ type: "json", prompt: SUMMARY_PROMPT, schema: SUMMARY_SCHEMA });
  const response = await requestFirecrawl("/v2/scrape", credentials.apiKey, {
    body: { url, formats, onlyMainContent: true, timeout: bodyTimeout(timeoutMs) },
    timeoutMs, signal,
  });
  const data = asRecord(response.body.data);
  if (!response.body.data || (typeof data.markdown !== "string" && !summary)) {
    throw new PermanentRunError("Firecrawl returned an unexpected response. No automatic retry was made.");
  }
  const metadata = asRecord(data.metadata);
  const json = asRecord(data.json);
  const statusCode = typeof metadata.statusCode === "number" ? metadata.statusCode : null;
  const markdown = text(data.markdown);
  const found = (statusCode === null || statusCode < 400) && (markdown !== null || Object.keys(json).length > 0);
  const logicalOutputs = {
    markdown, title: text(metadata.title), pageDescription: text(metadata.description),
    finalUrl: text(metadata.url) ?? text(metadata.sourceURL), statusCode,
    summary: data.json ?? null, companyName: json.companyName, companyDescription: json.description,
    products: Array.isArray(json.products) ? json.products : null, pricingModel: json.pricingModel, hiringSignals: json.hiringSignals,
    creditsUsed: credits(metadata.creditsUsed), data,
  };
  return {
    value: found ? "Found" : "Not found",
    outputs: mapConfiguredOutputs(config, logicalOutputs, data),
    provider: "firecrawl", outcome: found ? "hit" : "miss", costCents: 0,
    latencyMs: response.latencyMs,
    request: { method: "POST", endpoint: "/v2/scrape", inputKeys: Object.keys(inputs), formats: summary ? ["markdown", "json"] : ["markdown"] },
    response: truncate(data),
  };
}

function searchLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 5;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new PermanentRunError("Number of results: use a whole number from 1 to 10.");
  }
  return value;
}

async function searchWeb(context: IntegrationActionContext): Promise<CellResult> {
  const { config, inputs, credentials, timeoutMs, signal } = context;
  const query = typeof inputs.query === "string" ? inputs.query.trim() : "";
  if (!query || query.length > 500) throw new PermanentRunError("Search query: provide up to 500 characters.");
  const limit = searchLimit(inputs.limit);
  const includeMarkdown = inputs.includeMarkdown === true;
  const response = await requestFirecrawl("/v2/search", credentials.apiKey, {
    body: {
      query, limit, timeout: bodyTimeout(timeoutMs),
      ...(includeMarkdown ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
    },
    timeoutMs, signal,
  });
  const data = asRecord(response.body.data);
  if (!Array.isArray(data.web)) {
    throw new PermanentRunError("Firecrawl returned an unexpected response. No automatic retry was made.");
  }
  const results = data.web.map((item) => {
    const result = asRecord(item);
    return {
      title: text(result.title), url: text(result.url), snippet: text(result.description),
      ...(includeMarkdown ? { markdown: text(result.markdown) } : {}),
    };
  });
  const top = results[0];
  const logicalOutputs = {
    results, resultCount: results.length,
    topTitle: top?.title ?? null, topUrl: top?.url ?? null, topSnippet: top?.snippet ?? null,
    creditsUsed: credits(response.body.creditsUsed), data,
  };
  return {
    value: results.length ? "Found" : "Not found",
    outputs: mapConfiguredOutputs(config, logicalOutputs, data),
    provider: "firecrawl", outcome: results.length ? "hit" : "miss", costCents: 0,
    latencyMs: response.latencyMs,
    request: { method: "POST", endpoint: "/v2/search", inputKeys: Object.keys(inputs), limit, includeMarkdown },
    response: truncate(data),
  };
}

export const FIRECRAWL_HANDLERS: IntegrationActionHandlers = {
  "firecrawl.scrapeWebsite": scrapeWebsite,
  "firecrawl.searchWeb": searchWeb,
};
