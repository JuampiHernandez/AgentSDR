import { numberRule } from "@/lib/channels/rules";

/**
 * What a mailbox's "Name and daily limit" action may change. Pure, so the
 * route and the tests share one set of rules. The daily limit is checked
 * against the same bounds as the organization's Sending rule
 * (`email.dailySendLimit`), so a mailbox can never be set to something the
 * rule itself would refuse.
 */
export type MailboxSettingsUpdate = {
  /** null clears it: Gmail then shows the bare address. */
  displayName?: string | null;
  dailySendLimit?: number;
};

export const MAX_DISPLAY_NAME_LENGTH = 100;

export type ParsedMailboxSettings = { ok: true; update: MailboxSettingsUpdate } | { ok: false; error: string };

export function parseMailboxSettings(body: unknown): ParsedMailboxSettings {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "The body must be a JSON object" };
  const input = body as Record<string, unknown>;
  const update: MailboxSettingsUpdate = {};

  if ("displayName" in input) {
    const value = input.displayName;
    if (value !== null && typeof value !== "string") return { ok: false, error: "displayName must be a string or null" };
    const trimmed = value?.trim() ?? "";
    // A line break would let a name inject a header into the From line.
    if (/[\r\n]/.test(trimmed)) return { ok: false, error: "The display name must be one line" };
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      return { ok: false, error: `Keep the display name under ${MAX_DISPLAY_NAME_LENGTH} characters` };
    }
    update.displayName = trimmed || null;
  }

  if ("dailySendLimit" in input) {
    const rule = numberRule("email", "dailySendLimit");
    const value = input.dailySendLimit;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return { ok: false, error: "The daily limit must be a whole number" };
    }
    if (value < rule.min || value > rule.max) {
      return { ok: false, error: `The daily limit must be between ${rule.min} and ${rule.max}` };
    }
    update.dailySendLimit = value;
  }

  if (Object.keys(update).length === 0) return { ok: false, error: "Nothing to change: send displayName or dailySendLimit" };
  return { ok: true, update };
}
