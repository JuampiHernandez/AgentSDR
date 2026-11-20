import { describe, expect, test } from "bun:test";
import { numberRule } from "@/lib/channels/rules";
import { MAX_DISPLAY_NAME_LENGTH, parseMailboxSettings } from "./mailboxSettings";

const rule = numberRule("email", "dailySendLimit");

describe("mailbox settings", () => {
  test("takes a display name and a daily limit together", () => {
    expect(parseMailboxSettings({ displayName: "  Mukund from Noonlaunch ", dailySendLimit: 15 })).toEqual({
      ok: true,
      update: { displayName: "Mukund from Noonlaunch", dailySendLimit: 15 },
    });
  });

  test("takes either one alone, leaving the other untouched", () => {
    expect(parseMailboxSettings({ dailySendLimit: 20 })).toEqual({ ok: true, update: { dailySendLimit: 20 } });
    expect(parseMailboxSettings({ displayName: "Jane" })).toEqual({ ok: true, update: { displayName: "Jane" } });
  });

  test("an empty or null display name clears it", () => {
    expect(parseMailboxSettings({ displayName: "   " })).toEqual({ ok: true, update: { displayName: null } });
    expect(parseMailboxSettings({ displayName: null })).toEqual({ ok: true, update: { displayName: null } });
  });

  test("refuses a display name that is not one short line", () => {
    expect(parseMailboxSettings({ displayName: "Jane\r\nBcc: x@example.com" }).ok).toBe(false);
    expect(parseMailboxSettings({ displayName: "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1) }).ok).toBe(false);
    expect(parseMailboxSettings({ displayName: 42 }).ok).toBe(false);
  });

  test("keeps the daily limit within the Sending rule's bounds", () => {
    expect(parseMailboxSettings({ dailySendLimit: rule.min }).ok).toBe(true);
    expect(parseMailboxSettings({ dailySendLimit: rule.max }).ok).toBe(true);
    expect(parseMailboxSettings({ dailySendLimit: rule.min - 1 }).ok).toBe(false);
    expect(parseMailboxSettings({ dailySendLimit: rule.max + 1 }).ok).toBe(false);
    expect(parseMailboxSettings({ dailySendLimit: 12.5 }).ok).toBe(false);
    expect(parseMailboxSettings({ dailySendLimit: "15" }).ok).toBe(false);
  });

  test("refuses a body with nothing to change", () => {
    expect(parseMailboxSettings({}).ok).toBe(false);
    expect(parseMailboxSettings({ signatureHtml: "x" }).ok).toBe(false);
    expect(parseMailboxSettings(null).ok).toBe(false);
    expect(parseMailboxSettings([]).ok).toBe(false);
  });
});
