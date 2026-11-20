import { describe, expect, test } from "bun:test";
import {
  assignNewLeads,
  campaignMayUseMailbox,
  parseCampaignMailboxIds,
  spareCapacityFor,
  type MailboxSlot,
} from "./campaignMailboxes";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

function slots(...caps: Array<[string, number, number?]>): MailboxSlot[] {
  return caps.map(([mailboxId, capacity, alreadyQueued = 0]) => ({
    mailboxId,
    currentAvailableCapacity: capacity,
    queue: Array.from({ length: alreadyQueued }, (_, i) => `followup-${mailboxId}-${i}`),
  }));
}

function newLeads(campaignId: string, n: number, prefix = campaignId) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, campaignId }));
}

describe("campaign mailboxes", () => {
  test("null means every mailbox; a list means only those", () => {
    expect(campaignMayUseMailbox(null, A)).toBe(true);
    expect(campaignMayUseMailbox([A], A)).toBe(true);
    expect(campaignMayUseMailbox([A], B)).toBe(false);
    expect(campaignMayUseMailbox([], A)).toBe(false);
  });

  test("parses null, or a non-empty list of ids without duplicates", () => {
    expect(parseCampaignMailboxIds(null)).toEqual({ ok: true, mailboxIds: null });
    expect(parseCampaignMailboxIds([A, B, A.toUpperCase()])).toEqual({ ok: true, mailboxIds: [A, B] });
    expect(parseCampaignMailboxIds([]).ok).toBe(false);
    expect(parseCampaignMailboxIds(["not-a-uuid"]).ok).toBe(false);
    expect(parseCampaignMailboxIds(A).ok).toBe(false);
    expect(parseCampaignMailboxIds([A, 7]).ok).toBe(false);
  });

  test("with every campaign on all mailboxes it is the plain round robin", () => {
    const s = slots([A, 2], [B, 2], [C, 1]);
    const queued = assignNewLeads(newLeads("x", 6), s, new Map([["x", null]]));
    expect(queued).toBe(5);
    expect(s.map((slot) => slot.queue)).toEqual([["x-0", "x-3"], ["x-1", "x-4"], ["x-2"]]);
  });

  test("a campaign's leads only go to its own mailboxes", () => {
    const s = slots([A, 3], [B, 3], [C, 3]);
    const leads = [...newLeads("one", 4), ...newLeads("two", 2)];
    assignNewLeads(leads, s, new Map<string, string[] | null>([["one", [A, B]], ["two", [C]]]));
    expect(s[0].queue).toEqual(["one-0", "one-2"]);
    expect(s[1].queue).toEqual(["one-1", "one-3"]);
    expect(s[2].queue).toEqual(["two-0", "two-1"]);
  });

  test("a full mailbox pool skips that campaign's leads without starving the others", () => {
    const s = slots([A, 1], [B, 2]);
    const leads = [...newLeads("one", 3), ...newLeads("two", 1)];
    const queued = assignNewLeads(leads, s, new Map<string, string[] | null>([["one", [A]], ["two", [B]]]));
    expect(queued).toBe(2);
    expect(s[0].queue).toEqual(["one-0"]);
    expect(s[1].queue).toEqual(["two-0"]);
  });

  test("follow-ups already queued count against capacity", () => {
    const s = slots([A, 2, 2], [B, 2, 1]);
    assignNewLeads(newLeads("x", 3), s, new Map([["x", null]]));
    expect(s[0].queue).toHaveLength(2);
    expect(s[1].queue).toEqual(["followup-" + B + "-0", "x-0"]);
  });

  test("spare capacity counts only the campaign's mailboxes", () => {
    const s = slots([A, 5, 2], [B, 4], [C, 1, 1]);
    expect(spareCapacityFor(null, s)).toBe(7);
    expect(spareCapacityFor([A], s)).toBe(3);
    expect(spareCapacityFor([C], s)).toBe(0);
    expect(spareCapacityFor([], s)).toBe(0);
  });
});
