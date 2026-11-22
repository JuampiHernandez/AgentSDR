# Changelog

All notable changes to AgentSDR are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each release lists the database migrations it needs; see
[docs/maintainers/releasing.md](docs/maintainers/releasing.md).

## [Unreleased]

## [0.4.0] - 2026-11-22

**Upgrading from 0.3.1** needs the database migrations listed under
Migrations below, run in order before the new image starts serving. The image
does not contain them: run them from a checkout of this tag that can reach
your database (see [Upgrading](docs/self-hosting/production.mdx#upgrading)). Each
is guarded with IF NOT EXISTS and safe to re-run; upgrading a 0.3.1 database
this way gives exactly the schema a fresh 0.4.0 install creates:

```sh
git clone --branch v0.4.0 https://github.com/Kandid-ai/AgentSDR && cd AgentSDR
bun install --frozen-lockfile
export DATABASE_URL=postgres://…   # add DATABASE_SSL=disable for the bundled Compose database
for f in $(git log --reverse --diff-filter=A --name-only --format= v0.3.1..v0.4.0 -- 'scripts/add-*.ts' 'scripts/create-*.ts'); do
  bun --conditions=react-server "$f" || break
done
```

Then download the new `docker-compose.yml` (it names `0.4.0`) and
`docker compose up -d`. No environment variable was removed or renamed; the
new optional ones are under Configuration.

### Added

- **Merge field fallbacks, 2026-11-21.** `{{firstName|there}}` sends
  "there" to a lead with no first name instead of an empty string. Choosing a
  field from **Insert field** asks for optional fallback text, and the list
  now always offers the standard fields (first name, last name, full name,
  company, job title, email, company domain) even when no lead has them yet,
  each marked with how many leads are missing it. The preview says when a
  lead gets the fallback. A merge field is never read as `{A|B}` spin text.
  No migration.

- **AI assistants (MCP), 2026-11-13.** AgentSDR is an MCP server at
  `/api/mcp`. Connect Claude (web and desktop), Claude Code, Cursor or any
  MCP client and work **CRM, Action required** from a chat: read the queue and
  records, review, edit and send drafts, correct classifications, move
  stages, snooze, close and set Do Not Contact. Each connection carries its
  own permissions (`crm:read`, `crm:write`, `crm:send`), actions are recorded
  as "name via AI assistant", and **Settings, AI assistants** shows the server
  URL, setup steps and each person's connections with Disconnect. API keys now
  have permissions too (`campaigns:read`, `campaigns:write`, and the CRM
  ones); keys created earlier keep full access. See `docs/mcp.mdx`.
- **AI assistants find any lead and write like the team, 2026-11-14.**
  `crm_list_action_required` is now `crm_list_records`: the queue by default,
  or every open lead (waiting, follow-ups exhausted) or closed ones, by stage,
  sub-stage, channel and search. New read-only `crm_get_writing_guide` (the
  drafter's reply rules, the team's draft instructions, the lead's sender,
  local time, sequence step and matching Knowledge) and `crm_get_knowledge`.
  The rules are the Langfuse prompt `mcp/writing-rules`; saving the Langfuse
  integration or `scripts/seed-langfuse-prompts.ts` creates it. ChatGPT apps
  created earlier need a refresh to see the new tools.
- **Public API with API keys.** Owners and admins create keys in Settings,
  API keys; another application uses one to list email campaigns
  (`GET /api/v1/campaigns`), add leads to a campaign
  (`POST /api/v1/campaigns/:id/leads`, the same duplicate and suppression
  rules as a sheet import) and stop a lead's sequence without suppressing
  them (`POST /api/v1/campaigns/:id/leads/stop`). See `docs/api.mdx`.
- **Edit a mailbox's display name and daily limit.** Settings, Email,
  Mailboxes: a mailbox's menu has **Name and daily limit**. Both were set
  only when the mailbox was connected, and changing the "Emails per day"
  Sending rule does not touch mailboxes connected earlier, so there was no
  way to change either afterwards (`PATCH /api/outreach/mailboxes/:id`).
- **Choose which mailboxes an email campaign sends from.** A campaign's new
  **Mailboxes** tab: All mailboxes (as before, the default) or chosen ones,
  so separate campaigns can run from separate mailboxes. Each mailbox shows
  the other running campaigns that use it. New leads are only given a chosen
  mailbox; leads that already started keep theirs, so follow-ups stay in the
  same thread. Removing a mailbox takes it out of the campaigns that chose it.

- **CRM follow-ups chase every lead until they move up a stage or say stop.**
  Sending the reply from the CRM starts the stage's follow-ups. A sequence can
  send its follow-ups, and its immediate reply, by itself (**Send follow-ups
  automatically** / **Send the immediate reply automatically**, both off by
  default), paced per sending account and inside its hours; email follow-ups
  share the mailbox's gap and daily limit with campaigns. When a sequence runs
  out it continues with the one it names, so a lead is never left idle; the
  **Long-term loop** sends one useful touch every 21 days. A follow-up can go
  out on the lead's other channel (email or LinkedIn). New organizations get
  the ladder Interested, Meeting Booked, Meeting Done, Pilot, Customer (and
  No-show) with a sequence per stage; `scripts/apply-crm-follow-up-template.ts`
  brings an existing organization up to it.
- **Meetings.** A draft can carry `{{booking_link}}`, sent as the lead's own
  coded Cal.com link (a plain link to the same Cal.com user gets the code too).
  The Cal.com integration's webhook books or moves the meeting and the stage; a
  step can be timed before the meeting; after it, Action required asks "Did
  they show up?".
- **Out-of-office replies resume outreach** instead of reaching Action
  required: the campaign enrollments and CRM follow-ups the reply stopped are
  put back, due when they were or on the return day the notice gives. No draft
  is written and the record keeps its stage.
- **A hand-off to a new point of contact.** When a thread introduces someone
  else, the draft goes To them with the original person in Cc. Both draft
  editors show To and Cc.
- **Follow up later** on a chosen date (with why and what to do; the follow-up
  is drafted on the day) and **Discard lead**, from Action required.
- **CRM drafts** are told who they go out as, today's date in the
  organization's time zone and where the lead is in the sequence, and read the
  organization's Knowledge whole.
- **AI calling campaigns (Calling).** An AI agent calls leads over WhatsApp,
  sends WhatsApp messages and follows up by itself, from a reach sequence and
  a chase sequence for leads who agreed to a meeting but have not booked. Each
  campaign picks its goal, CRM Knowledge, instructions and voice; organization
  calling instructions live in Settings, Instructions, Calling. Calls go
  through Gemini Live or, per campaign, ElevenLabs (the `elevenlabs`
  integration); **Compare voices** rehearses a campaign's call with both.
  Calling hours, calls a day, warm-up and gaps are WhatsApp Sending rules.
  The agent also answers known leads who call back. Trial: see Configuration.
- **Cloud calling stations.** A WhatsApp number whose WhatsApp Web runs in a
  browser profile on a separate call worker (`services/call-worker`;
  CloakBrowser by default, GoLogin or Playwright's Chromium), so calls and
  messages need no rep's laptop. **Call now** lets a rep talk to a lead
  through a station from their own AgentSDR tab, the audio relayed by the app.
- **Langfuse** (prompts and tracing) is a per-organization integration in
  Settings, AI provider. A connected organization's prompts come from its
  Langfuse project and every model call is traced there; one that has not
  connected uses the prompts in code and traces nothing.
- **CompanyEnrich** company and people research integration for Tables.
- **Analytics** shows conversion from interested to customer and from booking
  links to meetings, and opens on the last 7 days.
- Lead searches match full names across first and last name, email, title
  and phone digits.

### Changed

- The Call campaigns page lists and creates AI campaigns only; a rep talks to
  a lead with **Call now**. Existing rep campaigns keep their data and links.
- A reply's AI classification always applies; the rep corrects the stage
  before replying, rather than confirming every one.
- AI-campaign booking links carry only a short code, not the contact's id.
  Links sent earlier still match.
- The brand font ships with the app instead of loading from Google Fonts.
- The Calling pages no longer require the Unipile integration.

### Fixed

- CRM sequences: Skip step and Snooze no longer strand the steps after the
  next one on an old version, where they were never drafted
  (`scripts/repair-crm-stale-step-versions.ts` repairs runs affected earlier).
- CRM send: a paused step's draft no longer blocks sending a reply on it.
- The campaign sequence editor keeps edits across tabs.
- The public demo no longer reloads in a loop on iPhone.
- The inbox composer keeps Send in view while typing a long reply.
- `{{booking_link}}` is refused where it cannot become a link.

### Configuration

All optional; nothing was removed or renamed. See
[docs/configuration.md](docs/configuration.md).

- `LANGFUSE_TRACING=off` stops traces for every organization (prompts keep
  working); `LANGFUSE_TRACING_ENVIRONMENT` names the environment.
- AI calling (trial): `GEMINI_API_KEY` (the live voice model's key, read from
  env while this is a trial), `CALL_WORKER_SECRET` (shared with the call
  worker), `AGENT_SAVE_HEARD_AUDIO` (test option).
- Pause switches `PAUSE_CRM_AUTOSEND`, `PAUSE_CRM_FOLLOWUP_DRAFTS`,
  `PAUSE_AI_CALLING`.
- AI assistants (MCP) issue OAuth tokens for `<BETTER_AUTH_URL>/api/mcp`, so
  `BETTER_AUTH_URL` must be the public address.

### Migrations

Run in this order (the loop above does exactly this). Each is
`bun --conditions=react-server scripts/<name>.ts`.

1. `create-calling-stations.ts`: `calling_stations` and the cloud-call
   columns on `call_sessions`.
2. `add-cloak-launcher.ts`: the CloakBrowser launcher option.
3. `create-calling-proxies.ts`: `calling_proxies`.
4. `add-calling-station-linked-phone.ts`, `add-calling-station-link-fresh.ts`.
5. `add-call-session-timeline.ts`.
6. `add-crm-auto-follow-ups.ts`: automatic CRM follow-up columns.
7. `add-calling-station-lease.ts`.
8. `add-call-session-agent-persona.ts`.
9. `add-ai-calling-campaigns.ts`: AI calling campaigns.
10. `add-ai-campaign-knowledge.ts`, `add-crm-calling-instructions.ts`,
    `add-ai-lead-instructions.ts`.
11. `add-call-session-direction.ts`, `add-call-session-remote-rep.ts`.
12. `add-ai-booking-code.ts`, `add-ai-meeting-at.ts`.
13. `create-api-keys.ts`: `api_keys`.
14. `add-api-key-scopes.ts`: `api_keys.scopes`.
15. `create-oauth-provider-tables.ts`: `jwks` and the `oauth_*` tables for AI
    assistants (MCP).
16. `add-crm-follow-up-system.ts`: sequence chaining, auto-sent replies and
    `crm_meetings`.
17. `add-crm-step-channel.ts`.
18. `add-ai-voice-engine.ts`.
19. `add-campaign-mailboxes.ts`: `outreach_campaigns.mailbox_ids`.
20. `add-crm-draft-recipients.ts`: `crm_drafts.to_email` and `cc_emails`.

Optional data scripts (dry run unless `--apply`; only if they apply to you):
`apply-crm-follow-up-template.ts` (the new stage ladder and sequences for an
existing organization), `backfill-crm-long-term-loop.ts` (idle interested
leads into the Long-term loop), `queue-existing-crm-follow-ups.ts`,
`repair-crm-stale-step-versions.ts`, `retry-crm-failed-classifications.ts`,
`seed-langfuse-prompts.ts` (saving the Langfuse integration already does this).

## [0.3.1] - 2026-10-08

### Fixed

- **`docker-compose.yml` names its release's image** (`0.3.1`) instead of
  `latest`. A server that had pulled an earlier `latest` kept running it with
  the new file: 0.2.0's image does not create the schema, so every query
  failed with `relation … does not exist`. Upgrade by downloading the new
  file; `AGENTSDR_VERSION` still overrides the tag.
- **First-run setup no longer loops.** On a fresh install the page bounced
  between `/sign-in` and `/setup` forever: the signed-in frame wrapped
  `/setup` and sent the session-less visitor to sign-in, which sent them back.
- **A rejected database password is explained at startup**: the bundled
  database keeps the password its volume was first created with, and the log
  now says so, with the two ways out.

## [0.3.0] - 2026-10-08

### Changed

- **Scheduled jobs run inside the app.** There is no cron container any more:
  Docker Compose is two containers, `db` and `app`. The jobs run in
  production only (never in `DEMO_MODE`); `INTERNAL_SCHEDULER=false` turns
  them off for an external cron, which calls the endpoints as before.
- **Database schema is created when the app starts.** The image creates it in
  an empty database before the server starts (there is no setup container). An
  existing database is only read, never changed. If this step fails the app
  does not start; `AGENTSDR_SKIP_DB_SETUP=true` skips it.
- **The daily rollover is per organization.** Each organization's email send
  queues, Gmail push watch renewal and LinkedIn daily-limit reset run at the
  start of its own day, set in Settings, Organization, Defaults (**Time zone**,
  default `UTC`, and **New day starts at**, default `00:00`). The first-run
  setup page stores the browser's time zone for the first organization.
- LinkedIn outreach now runs every 30 minutes, and the LinkedIn webhook replay
  every 10. The LinkedIn search queue is no longer scheduled: it runs when
  someone clicks Run.
- `CRON_SECRET` and `OUTREACH_TICK_SECRET` are optional: they are only needed
  to call the job endpoints from outside, and are no longer in
  `docker-compose.yml`. Unset, the endpoints refuse every secret call.
- The job endpoints skip work the in-app scheduler already did (organizations
  whose rollover ran today; a slot that already ran). `?force=1` skips that
  check.

### Fixed

- LinkedIn job logs: concurrent jobs no longer leave the console patched, so
  later lines landed in an old run's log. Log capture is now per run
  (`AsyncLocalStorage`).

### Migrations

- `bun scripts/create-scheduled-job-runs.ts` creates `scheduled_job_runs`,
  where each scheduled run is claimed. With Docker Compose:
  `docker compose exec app agentsdr-entrypoint bun scripts/create-scheduled-job-runs.ts`.
  A fresh install gets the table automatically. **Until the migration runs, no
  scheduled jobs run in-process** (the app logs a
  `[scheduler] Table scheduled_job_runs is missing` warning); the endpoints
  keep working.

**Upgrading a Docker Compose install from 0.2.0:**

1. Replace `docker-compose.yml` with the new one.
2. `docker compose up -d --remove-orphans` (removes the old `setup` and `cron`
   containers).
3. Run the migration above.

On Dokploy, nothing needs creating or scheduling any more; existing Schedule
Jobs are harmless and can be deleted. Keep `CRON_SECRET` and
`OUTREACH_TICK_SECRET` only if you keep calling the endpoints.

## [0.2.0] - 2026-10-08

**Upgrading a Docker Compose install from 0.1.0** (breaking): the new
`docker-compose.yml` no longer loads your whole `.env` into the containers;
it passes only the settings it lists by name. Before `docker compose up -d`:

1. Add `APP_URL=<your public address>` to `.env`. It replaces
   `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL`, which the new file does not
   read. Without it the app assumes `http://localhost:3000`.
2. Keep `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`,
   `INTEGRATION_CREDENTIALS_KEY`, `UNSUBSCRIBE_SECRET`, `CRON_SECRET` and
   `OUTREACH_TICK_SECRET` in `.env` exactly as they are.
3. Any other variable you relied on (a `PAUSE_*` switch, worker tuning,
   Apollo) must be added to the `environment` block of `docker-compose.yml`.

### Added

- **First-run setup page.** On a fresh install every visitor is sent to
  `/setup`: one form (name, organization, email, password) creates the first
  admin, already verified, and their organization, then signs them in. No
  email service is needed to get started. The page closes for good once an
  account exists.
- **Copy-and-run Docker Compose.** `docker-compose.yml` runs the published
  image (`ghcr.io/kandid-ai/agentsdr`), with no repository checkout and no
  files to mount. Every setting is listed by name in the file; the ones to
  replace are marked `# CHANGEME` and can be edited in place or set in a
  `.env`. It starts as-is on `localhost`; on any other `APP_URL` it refuses
  to start while a secret still has its placeholder. The scheduler runs from
  the same image. `docker-compose.build.yml` builds from source instead.
  The Docker guide is rewritten as numbered steps.
- **Public demo.** `DEMO_MODE=true` turns a separate deployment into a
  read-only AgentSDR anyone can open without signing in, and
  `bun run db:seed:demo` now fills it with Northwind, a fictional company's
  three months of email, LinkedIn and WhatsApp outbound, calls with
  transcripts, a full CRM pipeline with AI drafts awaiting review, Tables and
  Analytics. See docs/self-hosting/demo.mdx.

### Changed

- **License: MIT** (was AGPL-3.0-only). Anyone may use, modify, self-host,
  distribute and sell AgentSDR, including in closed-source products and
  hosted services, as long as the copyright and license notice is kept.
- **Email recipients**: inbound Gmail keeps every To and Cc, replies can go
  to all, and a colleague's reply joins the lead's thread.
  `scripts/backfill-email-recipients.ts` (optional, dry run by default)
  restores recipients on messages stored before.
- **Tables**: about 70 fixes across columns, AI and enrichment runs and the
  grid.
- **The app is only the app.** The marketing website, blog theme and launch
  film moved to their own repository (agentsdr.ai). `/` now opens the
  workspace (sign-in first), and the app asks search engines not to index it.
- **Call recorder 0.15.0**: the built-in hosted address is now
  `https://app.agentsdr.ai`. Self-hosted addresses are still added on the
  extension's Options page.

## [0.1.0] - 2026-10-06

The first public release.

### Added

- **Accounts, organizations and teams** with Better Auth: email and
  password sign-up with verification, Google sign-in, password reset,
  invitations, owner / admin / member roles, an organization switcher.
  Sign-up is invite-only by default (`AUTH_SIGNUP=open` opens it); the first
  account on a fresh install can always be created.
- **Multi-tenancy**: every record belongs to an organization; an isolation
  test suite (`scripts/e2e/tenancy-isolation.ts`) proves one organization
  cannot see, change or count another's data.
- **Per-organization integrations** configured in Settings — Unipile
  (LinkedIn and WhatsApp), Google Workspace (Gmail), Cloudflare R2,
  OpenRouter — with credentials encrypted at rest.
- Lead database with custom fields, email outreach with sequences and
  mailbox rotation, LinkedIn campaigns and search, WhatsApp messaging and
  recorded calls, an AI-assisted CRM inbox with reply classification and
  drafted responses, Tables with enrichment providers.
- **Fresh installs**: `bun run db:setup` creates the schema in an empty
  database from `db/schema.sql`; `bun run db:seed:demo` adds a demo
  organization with fictional data.
- **Unipile webhooks register themselves**: saving the Unipile integration
  registers the LinkedIn and WhatsApp webhooks in your Unipile workspace,
  each carrying your organization and a generated secret.
- **Settings by channel**: Email, LinkedIn and WhatsApp each have their
  accounts, their Connection (the integration they run on) and their
  **Sending rules** — the limits that used to be hardcoded (emails a day and
  the gap between them, sending hours, LinkedIn invitations a day and per run,
  delays, search leads a day, WhatsApp warm-up, new chats a day, seconds
  between sends) — with today's values as defaults, hard ceilings and a
  warning past the safe edge. A LinkedIn account or WhatsApp number can set
  its own daily limit; the default phone country is per organization.
  `/settings/integrations` redirects to the new pages.
- **Call recorder Options page**: add your own AgentSDR address in the
  extension; a self-hosted deployment no longer needs its own build.
- Docker Compose self-hosting, CI, and the project's community documents,
  including [responsible use](docs/responsible-use.md).
- **Public website** at [agentsdr.ai](https://agentsdr.ai): product pages for
  each channel, the AI CRM and the data tools, solutions for founders,
  agencies and sales teams, comparisons, guides and this changelog, with a
  sitemap and structured data for search.

### Migrations

- Existing single-workspace installations: follow
  [docs/multi-tenancy/cutover.md](docs/multi-tenancy/cutover.md)
  (`scripts/create-auth-tables.ts`, `scripts/add-organization-scope.ts`,
  then `scripts/finalize-organization-scope.ts` after deploying).
- Sending rules: `bun run scripts/add-channel-settings.ts` (additive; run it
  before deploying). The `WHATSAPP_*` sending variables are no longer read —
  set those limits in Settings → WhatsApp → Sending rules.

[Unreleased]: https://github.com/Kandid-ai/AgentSDR/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Kandid-ai/AgentSDR/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Kandid-ai/AgentSDR/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Kandid-ai/AgentSDR/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kandid-ai/AgentSDR/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kandid-ai/AgentSDR/releases/tag/v0.1.0
