/**
 * Timezone-aware working-hours window check, scoped to a mailbox. A day's
 * window runs from `from` to `to` on that calendar day, in the mailbox's
 * timezone. There are no overnight windows: a day whose end is at or before
 * its start sends nothing, as the Sending hours dialog says (issue #18; the
 * rules themselves are in sendWindow.ts).
 */
import { isWithinInterval, set as setTime } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import type { WorkingHours, WorkingDay } from "./schema";
import type { WeeklyHours } from "@/lib/channels/rules";

function parseHHmm(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(":").map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

function isWithinDayWindow(day: WorkingDay, now: Date, timezone: string): boolean {
  const zonedNow = toZonedTime(now, timezone);
  const { hours: sh, minutes: sm } = parseHHmm(day.from);
  const { hours: eh, minutes: em } = parseHHmm(day.to);

  const startTodayLocal = setTime(zonedNow, { hours: sh, minutes: sm, seconds: 0, milliseconds: 0 });
  const endTodayLocal = setTime(zonedNow, { hours: eh, minutes: em, seconds: 0, milliseconds: 0 });

  // An end at or before the start is an empty window, never an overnight one.
  if (endTodayLocal <= startTodayLocal) return false;

  const startUtc = fromZonedTime(startTodayLocal, timezone);
  const endUtc = fromZonedTime(endTodayLocal, timezone);
  return isWithinInterval(now, { start: startUtc, end: endUtc });
}

/** True if `now` falls inside this mailbox's configured send window for the current day (in its timezone). */
export function isWithinWorkingHours(workingHours: WorkingHours, now: Date = new Date()): boolean {
  try {
    const zonedNow = toZonedTime(now, workingHours.timezone);
    const dayName = DAY_NAMES[zonedNow.getDay()];
    const day = workingHours.days[dayName];
    if (!day?.enabled) return false;
    return isWithinDayWindow(day, now, workingHours.timezone);
  } catch (err) {
    console.error("[outreach/workingHours] isWithinWorkingHours error:", err);
    return false;
  }
}

/**
 * True if `last` falls on the same calendar day as `now`, in `timezone`.
 * Used to make the daily send-counter reset idempotent — if build-queue
 * runs twice in one day (duplicate cron fire, manual re-run to pick up a
 * newly-launched campaign), the second run must not re-zero a mailbox's
 * todayEmailsSent, or it would silently grant a second full daily allowance.
 */
export function isSameLocalDay(last: Date | null, now: Date, timezone: string): boolean {
  if (!last) return false;
  try {
    const zonedLast = toZonedTime(last, timezone);
    const zonedNow = toZonedTime(now, timezone);
    return (
      zonedLast.getFullYear() === zonedNow.getFullYear() &&
      zonedLast.getMonth() === zonedNow.getMonth() &&
      zonedLast.getDate() === zonedNow.getDate()
    );
  } catch (err) {
    console.error("[outreach/workingHours] isSameLocalDay error:", err);
    return false;
  }
}

/**
 * A mailbox's per-day hours from the organization's default sending hours
 * (Settings → Email → Sending rules): the same window on every chosen day.
 */
export function mailboxHoursFromWeekly(hours: WeeklyHours): WorkingHours {
  const days = Object.fromEntries(
    DAY_NAMES.map((name, index) => [name, { enabled: hours.days.includes(index), from: hours.start, to: hours.end }]),
  ) as WorkingHours["days"];
  return { timezone: hours.timezone, days };
}
