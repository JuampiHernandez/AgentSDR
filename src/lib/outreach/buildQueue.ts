/**
 * Daily queue build — Phase 1 of AgentSDR-app's two-phase send model, ported
 * from make-mailbox-queue-for-team.ts line-for-line (minus the team/domain
 * layer v2 doesn't have, and Redis lists swapped for the outreach_mailbox_queue
 * table). Runs once a day per organization, at the start of that
 * organization's day (the daily rollover, src/lib/scheduler/dailyRollover.ts;
 * /api/outreach/build-queue triggers it by hand or from an external cron),
 * before the frequent send tick starts draining it.
 *
 * Two-pass fill per mailbox, in this order:
 *   Pass A — leads already mid-sequence and due today get queued first,
 *     ordered by nextSendAt ASC then currentStep DESC: the most-overdue lead
 *     wins, and among equally-due leads the one furthest into its sequence
 *     (e.g. on its 4th follow-up) is queued ahead of one just starting out.
 *     Matches AgentSDR-app's `ORDER BY lead.nextFollowup, lead.followups DESC`.
 *   Pass B — brand-new (`pending`) leads round-robin fill whatever capacity
 *     is left over, same as AgentSDR-app's PENDING-lead fill pass. A campaign
 *     that names its mailboxes (`mailbox_ids`) only fills those.
 */
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes, outreachCampaigns, outreachLeads, outreachMailboxQueue } from "./schema";
import { isSameLocalDay } from "./workingHours";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { leadsInOrg, orgMailboxIds } from "./orgScope";
import { assignNewLeads, spareCapacityFor } from "./campaignMailboxes";

type MailboxCapacity = {
  mailboxId: string;
  queue: string[]; // lead ids, in order
  currentAvailableCapacity: number;
};

export type BuildQueueResult = {
  mailboxesConsidered: number;
  followUpsQueued: number;
  newLeadsQueued: number;
};

/**
 * Builds the queues of every organization that has a mailbox, or only of
 * `organizationIds` when given (the daily rollover passes one).
 */
export async function buildMailboxQueues(options: { organizationIds?: string[] } = {}): Promise<BuildQueueResult> {
  if (isMigrationControlPaused("emailOutbound")) {
    console.warn("[outreach/buildQueue] Email outbound is paused; queue rebuild skipped");
    return { mailboxesConsidered: 0, followUpsQueued: 0, newLeadsQueued: 0 };
  }

  // One run, one scope per organization: every organization's queue is
  // built from its own mailboxes, campaigns and leads and nothing else.
  const total: BuildQueueResult = { mailboxesConsidered: 0, followUpsQueued: 0, newLeadsQueued: 0 };
  const withMailboxes = await db.selectDistinct({ organizationId: mailboxes.organizationId }).from(mailboxes);
  const wanted = options.organizationIds ? new Set(options.organizationIds) : null;
  const organizations = wanted ? withMailboxes.filter((o) => wanted.has(o.organizationId)) : withMailboxes;
  for (const { organizationId } of organizations) {
    try {
      const part = await runInOrganization(organizationId, buildOrganizationQueues);
      total.mailboxesConsidered += part.mailboxesConsidered;
      total.followUpsQueued += part.followUpsQueued;
      total.newLeadsQueued += part.newLeadsQueued;
    } catch (err) {
      console.error(`[outreach/buildQueue] organization ${organizationId} failed:`, err);
    }
  }
  return total;
}

async function buildOrganizationQueues(): Promise<BuildQueueResult> {
  const now = new Date();

  // Wipe yesterday's leftover queue — safe to do unconditionally, a rebuild
  // always supersedes whatever was queued before.
  await db.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.mailboxId, orgMailboxIds()));
  const connectedMailboxes = await db
    .select()
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.status, "connected")));

  // Reset each mailbox's daily counter only if it hasn't already been reset
  // today (in that mailbox's own working-hours timezone) — build-queue must
  // stay safe to re-run more than once in a day (duplicate cron fire, or a
  // manual re-run to pick up a newly-launched campaign) without granting a
  // second full daily allowance by re-zeroing todayEmailsSent.
  const mailboxesNeedingReset = connectedMailboxes.filter(
    (m) => !isSameLocalDay(m.sendCounterResetAt, now, m.workingHours.timezone),
  );
  if (mailboxesNeedingReset.length > 0) {
    await db
      .update(mailboxes)
      .set({ todayEmailsSent: 0, sendCounterResetAt: now })
      .where(and(inOrg(mailboxes), inArray(mailboxes.id, mailboxesNeedingReset.map((m) => m.id))));
  }
  const resetIds = new Set(mailboxesNeedingReset.map((m) => m.id));

  const activeCampaigns = await db.select().from(outreachCampaigns).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.status, "active")));
  if (activeCampaigns.length === 0 || connectedMailboxes.length === 0) {
    return { mailboxesConsidered: connectedMailboxes.length, followUpsQueued: 0, newLeadsQueued: 0 };
  }
  const activeCampaignIds = activeCampaigns.map((c) => c.id);

  const queues = new Map<string, MailboxCapacity>();
  for (const mailbox of connectedMailboxes) {
    const todaySent = resetIds.has(mailbox.id) ? 0 : mailbox.todayEmailsSent;
    queues.set(mailbox.id, {
      mailboxId: mailbox.id,
      queue: [],
      currentAvailableCapacity: Math.max(0, mailbox.dailySendLimit - todaySent),
    });
  }
  const mailboxIds = connectedMailboxes.map((m) => m.id);

  // Pass A: leads mid-sequence, due now, pinned to a connected mailbox with
  // capacity — most-overdue and deepest-into-sequence first.
  const dueFollowUps = await db
    .select()
    .from(outreachLeads)
    .where(
      and(
        leadsInOrg(),
        inArray(outreachLeads.mailboxId, mailboxIds),
        inArray(outreachLeads.campaignId, activeCampaignIds),
        or(eq(outreachLeads.sequenceStatus, "initial_sent"), eq(outreachLeads.sequenceStatus, "in_follow_up")),
        lte(outreachLeads.nextSendAt, now),
      ),
    )
    .orderBy(asc(outreachLeads.nextSendAt), desc(outreachLeads.currentStep));

  let followUpsQueued = 0;
  for (const lead of dueFollowUps) {
    if (!lead.mailboxId) continue;
    const cap = queues.get(lead.mailboxId);
    if (!cap) continue;
    if (cap.queue.length >= cap.currentAvailableCapacity) continue;
    cap.queue.push(lead.id);
    followUpsQueued += 1;
  }

  // Pass B: brand-new leads round-robin fill whatever capacity remains, each
  // only into a mailbox its campaign may use (campaignMailboxes.ts). Loaded
  // per campaign, up to the spare capacity of that campaign's mailboxes, then
  // merged oldest first, the order a single query used to give.
  const slots = Array.from(queues.values());
  const campaignMailboxIds = new Map(activeCampaigns.map((c) => [c.id, c.mailboxIds ?? null]));
  const alreadyQueuedLeadIds = slots.flatMap((cap) => cap.queue);
  const candidates: Array<{ id: string; campaignId: string; createdAt: Date | null }> = [];
  for (const campaign of activeCampaigns) {
    const spare = spareCapacityFor(campaign.mailboxIds ?? null, slots);
    if (spare === 0) continue;
    const pending = await db
      .select({ id: outreachLeads.id, campaignId: outreachLeads.campaignId, createdAt: outreachLeads.createdAt })
      .from(outreachLeads)
      .where(
        and(
          leadsInOrg(),
          eq(outreachLeads.campaignId, campaign.id),
          eq(outreachLeads.sequenceStatus, "pending"),
          isNull(outreachLeads.mailboxId),
          alreadyQueuedLeadIds.length > 0 ? notInArray(outreachLeads.id, alreadyQueuedLeadIds) : undefined,
        ),
      )
      .orderBy(asc(outreachLeads.createdAt))
      .limit(spare);
    candidates.push(...pending);
  }
  candidates.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  const newLeadsQueued = assignNewLeads(candidates, slots, campaignMailboxIds);

  const rows: Array<{ mailboxId: string; leadId: string; position: number }> = [];
  for (const cap of queues.values()) {
    cap.queue.forEach((leadId, index) => rows.push({ mailboxId: cap.mailboxId, leadId, position: index }));
  }
  if (rows.length > 0) {
    await db.insert(outreachMailboxQueue).values(rows)
      .onConflictDoNothing({ target: outreachMailboxQueue.leadId });
  }

  return { mailboxesConsidered: connectedMailboxes.length, followUpsQueued, newLeadsQueued };
}
