/**
 * Pure, client-safe rules for a mailbox's sending window: what counts as a
 * valid day, and whether the daily limit fits inside the window at the
 * Sending rules' gap. The settings dialogs, the Sending rules form and the
 * working-hours route all read these, so the warning a person sees and what
 * the server accepts cannot drift apart.
 *
 * A day's window runs from `from` to `to` on that calendar day. There are no
 * overnight windows: a day whose end is at or before its start sends nothing,
 * and saving one is refused (the organization's Sending rules refuse it too).
 */
import type { WorkingHours } from "./schema";
import { isTimeZone, type WeeklyHours } from "@/lib/channels/rules";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_LABEL: Record<(typeof DAY_ORDER)[number], string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};
/** WeeklyHours numbers days 0 = Sunday … 6 = Saturday. */
const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Minutes between `from` and `to` on one day; 0 when the end is not after the start. */
export function windowMinutes(from: string, to: string): number {
  return Math.max(toMinutes(to) - toMinutes(from), 0);
}

/** Why these working hours can't be saved, or null when they can. */
export function workingHoursError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "Sending hours are missing.";
  const wh = value as Partial<WorkingHours>;
  if (typeof wh.timezone !== "string" || !isTimeZone(wh.timezone)) return "Unknown timezone.";
  if (!wh.days || typeof wh.days !== "object") return "Sending hours need a setting for each day.";
  const inverted: string[] = [];
  for (const key of DAY_ORDER) {
    const day = wh.days[key];
    if (!day || typeof day.enabled !== "boolean" || typeof day.from !== "string" || typeof day.to !== "string") {
      return `${DAY_LABEL[key]} is missing its hours.`;
    }
    if (!HHMM.test(day.from) || !HHMM.test(day.to)) return `${DAY_LABEL[key]}: times must look like 09:00.`;
    if (day.enabled && day.from >= day.to) inverted.push(DAY_LABEL[key]);
  }
  if (inverted.length) return `${listOf(inverted)}: the end must be after the start.`;
  return null;
}

/** One enabled day's window, for the capacity check. */
export type DayWindow = { label: string; minutes: number };

/** The enabled days of a mailbox's own hours. */
export function mailboxDayWindows(wh: WorkingHours): DayWindow[] {
  return DAY_ORDER.filter((key) => wh.days[key]?.enabled).map((key) => ({
    label: DAY_LABEL[key],
    minutes: windowMinutes(wh.days[key].from, wh.days[key].to),
  }));
}

/** The chosen days of an organization's weekly sending hours. */
export function weeklyDayWindows(hours: WeeklyHours): DayWindow[] {
  const minutes = windowMinutes(hours.start, hours.end);
  return [...hours.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => ({ label: WEEKDAY_LABEL[d], minutes }));
}

/**
 * Emails one mailbox can send in `minutes`: one at the start, then one after
 * each gap. The gap is random within the Sending rule's range, so this uses
 * its middle. At the defaults (09:00-18:00, 18-24 minutes) that is 26, which
 * matches what mailboxes actually send there.
 */
export function emailsThatFit(minutes: number, gapMinutes: readonly [number, number]): number {
  if (minutes <= 0) return 0;
  const averageGap = Math.max((gapMinutes[0] + gapMinutes[1]) / 2, 1);
  return Math.floor(minutes / averageGap) + 1;
}

export type CapacityShortfall = {
  /** The emails the shortest short day fits. */
  fits: number;
  limit: number;
  /** That day's window. */
  minutes: number;
  averageGap: number;
  /** The days with that shortest window, in week order. */
  days: string[];
  /** True when every enabled day has that window, so the message need not name them. */
  allDays: boolean;
};

/**
 * Null when the daily limit fits inside every enabled day at this gap;
 * otherwise the days where it does not. Days with an empty window are left
 * to `workingHoursError`.
 */
export function capacityShortfall(
  days: DayWindow[],
  dailyLimit: number,
  gapMinutes: readonly [number, number],
): CapacityShortfall | null {
  const open = days.filter((d) => d.minutes > 0);
  const short = open.filter((d) => emailsThatFit(d.minutes, gapMinutes) < dailyLimit);
  if (!short.length || !Number.isFinite(dailyLimit) || dailyLimit < 1) return null;
  const worst = short.reduce((a, b) => (b.minutes < a.minutes ? b : a));
  const worstDays = short.filter((d) => d.minutes === worst.minutes);
  return {
    fits: emailsThatFit(worst.minutes, gapMinutes),
    limit: dailyLimit,
    minutes: worst.minutes,
    averageGap: (gapMinutes[0] + gapMinutes[1]) / 2,
    days: worstDays.map((d) => d.label),
    allDays: worstDays.length === open.length,
  };
}

/** "9 hours", "7 hours 30 minutes", "45 minutes". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} ${h === 1 ? "hour" : "hours"}` : "";
  const mins = m ? `${m} ${m === 1 ? "minute" : "minutes"}` : "";
  return [hours, mins].filter(Boolean).join(" ") || "0 minutes";
}

/** The minutes one mailbox needs to send `limit` emails at this gap. */
export function minutesNeeded(limit: number, gapMinutes: readonly [number, number]): number {
  return Math.ceil(Math.max(limit - 1, 0) * ((gapMinutes[0] + gapMinutes[1]) / 2));
}

/** The warning sentence for a shortfall, written for the mailbox it describes. */
export function describeShortfall(s: CapacityShortfall, subject = "this mailbox", gapSetting = "in Email → Sending rules"): string {
  const gap = Number.isInteger(s.averageGap) ? String(s.averageGap) : s.averageGap.toFixed(1);
  const when = s.allDays ? "A" : `On ${listOf(s.days)}, a`;
  const needed = formatDuration(minutesNeeded(s.limit, [s.averageGap, s.averageGap]));
  return (
    `${when} sending window of ${formatDuration(s.minutes)} fits about ${s.fits} emails at about ${gap} minutes apart, ` +
    `so ${subject} may not send all ${s.limit} a day (that needs about ${needed}). Lengthen the sending hours, ` +
    `lower the daily limit, or shorten the gap between emails ${gapSetting}.`
  );
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
