import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKING_HOURS, type WorkingDay, type WorkingHours } from "./schema";
import {
  capacityShortfall,
  describeShortfall,
  emailsThatFit,
  mailboxDayWindows,
  weeklyDayWindows,
  windowMinutes,
  workingHoursError,
} from "./sendWindow";
import { isWithinWorkingHours } from "./workingHours";

const off: WorkingDay = { enabled: false, from: "09:00", to: "18:00" };

function onlyMonday(from: string, to: string): WorkingHours {
  return {
    timezone: "America/New_York",
    days: { monday: { enabled: true, from, to }, tuesday: off, wednesday: off, thursday: off, friday: off, saturday: off, sunday: off },
  };
}

describe("isWithinWorkingHours (issue #18)", () => {
  test("a day that ends before it starts sends nothing, as the dialog says", () => {
    const hours = onlyMonday("18:00", "09:00");
    expect(isWithinWorkingHours(hours, new Date("2026-07-20T23:00:00-04:00"))).toBe(false);
    expect(isWithinWorkingHours(hours, new Date("2026-07-20T12:00:00-04:00"))).toBe(false);
  });

  test("it does not reach back into the previous, disabled day", () => {
    expect(isWithinWorkingHours(onlyMonday("18:00", "09:00"), new Date("2026-07-20T02:00:00-04:00"))).toBe(false);
  });

  test("a day that ends when it starts sends nothing, rather than all day", () => {
    expect(isWithinWorkingHours(onlyMonday("09:00", "09:00"), new Date("2026-07-20T12:00:00-04:00"))).toBe(false);
  });

  test("a normal window still sends inside it and not outside", () => {
    const hours = onlyMonday("09:00", "18:00");
    expect(isWithinWorkingHours(hours, new Date("2026-07-20T09:30:00-04:00"))).toBe(true);
    expect(isWithinWorkingHours(hours, new Date("2026-07-20T08:59:00-04:00"))).toBe(false);
    expect(isWithinWorkingHours(hours, new Date("2026-07-20T19:00:00-04:00"))).toBe(false);
    expect(isWithinWorkingHours(hours, new Date("2026-07-21T12:00:00-04:00"))).toBe(false);
  });
});

describe("workingHoursError", () => {
  test("accepts the default hours", () => {
    expect(workingHoursError(DEFAULT_WORKING_HOURS)).toBeNull();
  });

  test("refuses an enabled day that ends at or before it starts, naming it", () => {
    expect(workingHoursError(onlyMonday("18:00", "09:00"))).toBe("Monday: the end must be after the start.");
    expect(workingHoursError(onlyMonday("09:00", "09:00"))).toBe("Monday: the end must be after the start.");
  });

  test("ignores the times of a day that is off", () => {
    const hours = onlyMonday("09:00", "18:00");
    hours.days.sunday = { enabled: false, from: "18:00", to: "09:00" };
    expect(workingHoursError(hours)).toBeNull();
  });

  test("refuses a malformed body", () => {
    expect(workingHoursError(null)).not.toBeNull();
    expect(workingHoursError({ ...DEFAULT_WORKING_HOURS, timezone: "Mars/Base" })).toBe("Unknown timezone.");
    expect(workingHoursError({ ...onlyMonday("9am", "18:00") })).toBe("Monday: times must look like 09:00.");
    expect(workingHoursError({ timezone: "UTC", days: { monday: off } })).toBe("Tuesday is missing its hours.");
  });
});

describe("capacity", () => {
  test("one email at the start, then one per average gap", () => {
    expect(windowMinutes("09:00", "18:00")).toBe(540);
    expect(windowMinutes("18:00", "09:00")).toBe(0);
    // The defaults: 9 hours at 18-24 minutes. Live mailboxes sent at most 27 a day.
    expect(emailsThatFit(540, [18, 24])).toBe(26);
    expect(emailsThatFit(450, [15, 15])).toBe(31);
    expect(emailsThatFit(0, [15, 15])).toBe(0);
  });

  test("warns when the limit does not fit, naming the short days", () => {
    const hours = onlyMonday("09:00", "18:00");
    hours.days.friday = { enabled: true, from: "09:00", to: "12:00" };
    expect(capacityShortfall(mailboxDayWindows(hours), 20, [18, 24])).toEqual({
      fits: 9,
      limit: 20,
      minutes: 180,
      averageGap: 21,
      days: ["Friday"],
      allDays: false,
    });
  });

  test("names the shortest day when the days differ", () => {
    const hours = onlyMonday("09:00", "18:00");
    hours.days.friday = { enabled: true, from: "09:00", to: "13:00" };
    const s = capacityShortfall(mailboxDayWindows(hours), 30, [18, 24]);
    expect(s).toMatchObject({ fits: 12, days: ["Friday"], allDays: false });
    expect(describeShortfall(s!)).toStartWith("On Friday, a sending window of 4 hours fits about 12 emails");
  });

  test("no warning when the limit fits every day", () => {
    expect(capacityShortfall(mailboxDayWindows(onlyMonday("09:00", "18:00")), 30, [15, 15])).toBeNull();
  });

  test("the message says what fits and how long the limit needs", () => {
    const s = capacityShortfall(weeklyDayWindows({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }), 30, [18, 24]);
    expect(s?.allDays).toBe(true);
    expect(describeShortfall(s!)).toBe(
      "A sending window of 9 hours fits about 26 emails at about 21 minutes apart, so this mailbox may not send all 30 a day " +
        "(that needs about 10 hours 9 minutes). Lengthen the sending hours, lower the daily limit, or shorten the gap " +
        "between emails in Email → Sending rules.",
    );
  });
});
