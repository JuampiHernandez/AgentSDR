/**
 * Which mailboxes an email campaign may send from. Pure, so the queue build,
 * the route and the tests share one set of rules.
 *
 * `outreach_campaigns.mailbox_ids` is null for "every connected mailbox"
 * (every campaign before the column existed, and the default) or a list.
 * The list only decides which mailbox a NEW lead is given: once a lead's
 * first email has gone out it stays on that mailbox, so its follow-ups reply
 * in the same Gmail thread even if the campaign's list changes later.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a campaign with this setting may give a new lead to this mailbox. */
export function campaignMayUseMailbox(campaignMailboxIds: readonly string[] | null, mailboxId: string): boolean {
  return campaignMailboxIds === null || campaignMailboxIds.includes(mailboxId);
}

export type ParsedCampaignMailboxes = { ok: true; mailboxIds: string[] | null } | { ok: false; error: string };

/**
 * The `mailboxIds` of a campaign PATCH: null (all mailboxes) or a non-empty
 * list of ids, de-duplicated. Whether each id is one of the organization's
 * mailboxes is checked by the caller against the database.
 */
export function parseCampaignMailboxIds(value: unknown): ParsedCampaignMailboxes {
  if (value === null) return { ok: true, mailboxIds: null };
  if (!Array.isArray(value)) return { ok: false, error: "mailboxIds must be null (all mailboxes) or a list of mailbox ids" };
  if (value.length === 0) return { ok: false, error: "Choose at least one mailbox, or send null to use all of them" };
  if (!value.every((id) => typeof id === "string" && UUID.test(id))) return { ok: false, error: "mailboxIds must be mailbox ids" };
  return { ok: true, mailboxIds: [...new Set((value as string[]).map((id) => id.toLowerCase()))] };
}

export type NewLead = { id: string; campaignId: string };
export type MailboxSlot = { mailboxId: string; queue: string[]; currentAvailableCapacity: number };

/**
 * Gives new leads (oldest first) to mailboxes with spare capacity, round
 * robin, each only to a mailbox its campaign may use. With every campaign on
 * all mailboxes this is exactly the plain round robin the queue build always
 * did. A lead none of whose mailboxes has room is left for another day.
 * Mutates `slots[].queue`; returns how many leads were queued.
 */
export function assignNewLeads(
  leads: readonly NewLead[],
  slots: readonly MailboxSlot[],
  campaignMailboxIds: ReadonlyMap<string, readonly string[] | null>,
): number {
  const cycle = slots.filter((slot) => slot.queue.length < slot.currentAvailableCapacity);
  let queued = 0;
  for (const lead of leads) {
    if (cycle.length === 0) break;
    const allowed = campaignMailboxIds.get(lead.campaignId) ?? null;
    const index = cycle.findIndex((slot) => campaignMayUseMailbox(allowed, slot.mailboxId));
    if (index === -1) continue;
    const [slot] = cycle.splice(index, 1);
    slot.queue.push(lead.id);
    queued += 1;
    if (slot.queue.length < slot.currentAvailableCapacity) cycle.push(slot);
  }
  return queued;
}

/**
 * How many new leads to load for each campaign: the spare capacity of the
 * mailboxes it may use. Loading per campaign keeps one big campaign's backlog
 * from crowding out a campaign whose mailboxes it cannot use.
 */
export function spareCapacityFor(campaignMailboxIds: readonly string[] | null, slots: readonly MailboxSlot[]): number {
  return slots
    .filter((slot) => campaignMayUseMailbox(campaignMailboxIds, slot.mailboxId))
    .reduce((sum, slot) => sum + Math.max(0, slot.currentAvailableCapacity - slot.queue.length), 0);
}
