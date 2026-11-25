import type { ActionOutputDefinition, IntegrationDefinition } from "../types";

const UTM = "utm_source=agentsdr&utm_medium=integration";

const responseOutputs: ActionOutputDefinition[] = [
  { key: "creditsUsed", name: "Credits used", description: "Firecrawl credits reported for this request. Empty when the API does not report usage; not a currency amount.", columnType: "number" },
  { key: "data", name: "Full response", description: "The complete data object Firecrawl returned.", columnType: "json" },
];

export const FIRECRAWL_SUMMARY_OUTPUT_KEYS = ["summary", "companyName", "companyDescription", "products", "pricingModel", "hiringSignals"] as const;

export const FIRECRAWL: IntegrationDefinition = {
  key: "firecrawl",
  name: "Firecrawl",
  description: "Search the web and read company websites as clean Markdown or a JSON summary, using your Firecrawl account.",
  websiteUrl: `https://www.firecrawl.dev/?${UTM}`,
  iconText: "FC",
  iconBackground: "#FA5D19",
  auth: {
    type: "api_key",
    fields: [{ key: "apiKey", label: "API key", placeholder: "fc-..., without Bearer", inputType: "password", required: true }],
    helpUrl: `https://www.firecrawl.dev/app/api-keys?${UTM}`,
  },
  actions: [
    {
      key: "scrape-website",
      name: "Scrape company website",
      description: "Read one page, such as a company homepage, as clean Markdown. Map any summary output to also get a JSON summary of the company (description, products, pricing model, hiring signals), which uses more Firecrawl credits.",
      docsUrl: `https://docs.firecrawl.dev/api-reference/endpoint/scrape?${UTM}`,
      category: "enrich-company-info", type: "enrichment", tags: ["website", "scrape", "markdown", "company research"],
      inputs: [{ key: "url", name: "Website or URL", description: "A company domain such as example.com, or the full URL of a page such as https://example.com/pricing.", valueType: "domain", acceptedColumnTypes: ["text", "url"], required: true, example: "example.com" }],
      outputs: [
        { key: "markdown", name: "Page Markdown", columnType: "text" },
        { key: "title", name: "Page title", columnType: "text" },
        { key: "pageDescription", name: "Page meta description", columnType: "text" },
        { key: "finalUrl", name: "Final URL", description: "The page URL after redirects.", columnType: "url" },
        { key: "statusCode", name: "HTTP status", description: "The status the website answered with.", columnType: "number" },
        { key: "summary", name: "Company summary", description: "JSON summary of the company. Mapping it requests the JSON format, which uses more Firecrawl credits.", columnType: "json" },
        { key: "companyName", name: "Company name (summary)", columnType: "text" },
        { key: "companyDescription", name: "Company description (summary)", columnType: "text" },
        { key: "products", name: "Products (summary)", columnType: "json" },
        { key: "pricingModel", name: "Pricing model (summary)", columnType: "text" },
        { key: "hiringSignals", name: "Hiring signals (summary)", columnType: "text" },
        ...responseOutputs,
      ],
      handlerKey: "firecrawl.scrapeWebsite", implemented: true,
    },
    {
      key: "search-web",
      name: "Search the web",
      description: "Search the web for a query, such as a company name plus funding or hiring, and return the top results with title, URL and snippet. Optionally include each result page as Markdown, which uses more Firecrawl credits.",
      docsUrl: `https://docs.firecrawl.dev/api-reference/endpoint/search?${UTM}`,
      category: "tools", type: "enrichment", tags: ["web search", "news", "signals", "company research"],
      inputs: [
        { key: "query", name: "Search query", description: "What to search for, up to 500 characters.", valueType: "text", acceptedColumnTypes: ["text"], required: true, example: "Example Inc funding" },
        { key: "limit", name: "Number of results", description: "From 1 to 10. Defaults to 5.", valueType: "number", acceptedColumnTypes: ["number"], required: false, group: "advanced" },
        { key: "includeMarkdown", name: "Include page Markdown", description: "Also scrape each result page and return its content as Markdown. Uses more Firecrawl credits.", valueType: "boolean", acceptedColumnTypes: ["boolean"], required: false, group: "advanced" },
      ],
      outputs: [
        { key: "results", name: "Results", description: "Each result's title, url, snippet and, when requested, markdown.", columnType: "json" },
        { key: "resultCount", name: "Results returned", columnType: "number" },
        { key: "topTitle", name: "Top result title", columnType: "text" },
        { key: "topUrl", name: "Top result URL", columnType: "url" },
        { key: "topSnippet", name: "Top result snippet", columnType: "text" },
        ...responseOutputs,
      ],
      handlerKey: "firecrawl.searchWeb", implemented: true,
    },
  ],
};
