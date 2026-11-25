# Firecrawl

[Firecrawl](https://www.firecrawl.dev/?utm_source=agentsdr&utm_medium=integration) reads web pages and searches the web through one API. This provider adds the two actions proposed in [#16](https://github.com/Kandid-ai/AgentSDR/issues/16): scrape a company website and search the web. It is optional and does nothing until an organization connects its own Firecrawl API key.

## Connect and run

1. Open a table's enrichment dialog, select **Firecrawl**, and choose an action. Under **Account**, choose **Add account**, paste an API key from the [Firecrawl dashboard](https://www.firecrawl.dev/app/api-keys?utm_source=agentsdr&utm_medium=integration) without the `Bearer` prefix, and select **Verify & connect**. AgentSDR stores it through the existing organization-scoped encrypted connection system. The key check calls `GET /v2/team/credit-usage`, which uses no credits, and discards the response.
2. Bind the input columns and map the outputs you want to table columns.
3. Run a row or a selection. Every execution makes one Firecrawl request.

| Action | Inputs | Outputs |
| --- | --- | --- |
| [Scrape company website](https://docs.firecrawl.dev/api-reference/endpoint/scrape?utm_source=agentsdr&utm_medium=integration) | A domain (`example.com`) or a full page URL (`https://example.com/pricing`) | The page's main content as Markdown, title, meta description, final URL and HTTP status. Mapping any summary output (company summary, name, description, products, pricing model, hiring signals) also requests a JSON summary of the company, which uses more Firecrawl credits. |
| [Search the web](https://docs.firecrawl.dev/api-reference/endpoint/search?utm_source=agentsdr&utm_medium=integration) | A query, plus optional number of results (1 to 10, default 5) and **Include page Markdown** | A JSON list of results with `title`, `url`, `snippet` and, when requested, `markdown`; the count; and the top result's title, URL and snippet. Including page Markdown scrapes each result and uses more Firecrawl credits. |

Both actions report **Credits used** as Firecrawl returns it (empty when the API does not report it) and keep the complete data object in **Full response**, so JSON-pointer output mappings work too. Firecrawl credits are not currency, so AgentSDR's monetary cost stays zero. See [pricing](https://www.firecrawl.dev/pricing?utm_source=agentsdr&utm_medium=integration) for what each request costs.

A website that answers with an error status (for example 404) is a miss, not an error. A domain that does not resolve fails with Firecrawl's own message.

## Failure handling

Requests go only to `https://api.firecrawl.dev`, refuse redirects, stop at the cell timeout (Firecrawl is asked to finish two seconds earlier) and read at most 5 MiB of response. The key is sent only in the `Authorization` header and never appears in results, audit rows or error messages. Inputs are checked before any request is made.

Requests carry `origin: "agentsdr"`. The handler never retries on its own. A rate limit (HTTP 429) is handed to the queue as retryable because Firecrawl does not process a rate-limited request. Every other failure, including a timeout or a dropped connection, is permanent so the queue cannot replay a request that may already have used Firecrawl credits. Check account usage before retrying by hand.

## Validation

The TypeScript fixtures call the registered handlers and verifier with mocked HTTP responses. They cover request bodies, output mapping, when the JSON summary and page Markdown are requested, input validation before any request, response-size limits, cancelled jobs, error handling and retry behavior, per-connection keys and credential verification. They use no real key and make no paid calls.

```sh
bun test --conditions=react-server src/lib/integrations/firecrawl/actions.test.ts
bun run typecheck
bun run lint
bun run test
bun run build
```
