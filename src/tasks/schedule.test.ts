/**
 * Unit tests for schedule parsing + next-run computation (issue #2).
 *
 * Schedules run in the host's LOCAL timezone, so expectations are built with
 * the local-time Date constructor (`at(...)`) — the suite passes in any TZ.
 * Times near midnight / 02:00 are avoided so no expectation lands in a DST gap.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { computeNextRun, describeSchedule, parseLocalDateTime, parseScheduleDetail, parseTime } from "./schedule.js";
import type { Schedule, ScheduleType } from "./types.js";

/** Local-time epoch ms; `month` is 1-based for readability. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const HOUR = 3_600_000;

describe("parseTime", () => {
  test("accepts H:MM and HH:MM (trimmed)", () => {
    assert.deepEqual(parseTime("9:05"), { h: 9, m: 5 });
    assert.deepEqual(parseTime(" 23:59 "), { h: 23, m: 59 });
    assert.deepEqual(parseTime("00:00"), { h: 0, m: 0 });
  });

  test("rejects out-of-range or malformed times", () => {
    for (const bad of ["24:00", "12:60", "7:5", "123:00", "-1:30", "12", "12:30pm", "", "ab:cd"]) {
      assert.equal(parseTime(bad), undefined, `expected "${bad}" to be rejected`);
    }
  });
});

describe("parseLocalDateTime", () => {
  test("parses YYYY-MM-DD HH:MM as local time (T separator, H:MM and :SS allowed)", () => {
    assert.equal(parseLocalDateTime("2030-01-15 10:30"), at(2030, 1, 15, 10, 30));
    assert.equal(parseLocalDateTime(" 2030-01-15T10:30 "), at(2030, 1, 15, 10, 30));
    assert.equal(parseLocalDateTime("2030-01-15 9:05"), at(2030, 1, 15, 9, 5));
    assert.equal(parseLocalDateTime("2030-01-15 10:30:45"), at(2030, 1, 15, 10, 30) + 45_000);
    assert.equal(parseLocalDateTime("2028-02-29 12:00"), at(2028, 2, 29, 12, 0));
  });

  test("rejects impossible calendar dates instead of rolling them over", () => {
    for (const bad of ["2030-02-30 10:00", "2029-02-29 10:00", "2030-04-31 10:00", "2030-13-01 10:00", "2030-00-10 10:00"]) {
      assert.equal(parseLocalDateTime(bad), undefined, `"${bad}"`);
    }
  });

  test("rejects out-of-range times and non-ISO shapes", () => {
    for (const bad of ["2030-01-15 24:00", "2030-01-15 10:60", "2030-01-15 10:30:60", "2030-1-5 9:00", "2030/01/15 10:00", "2030-01-15", "next friday 2030", ""]) {
      assert.equal(parseLocalDateTime(bad), undefined, `"${bad}"`);
    }
  });
});

describe("parseScheduleDetail", () => {
  test("daily normalizes the time to HH:MM", () => {
    assert.deepEqual(parseScheduleDetail("daily", " 9:05 "), { schedule: { type: "daily", time: "09:05" } });
  });

  test("daily rejects an invalid time", () => {
    for (const bad of ["25:00", "9:60", "nine", ""]) {
      assert.match(parseScheduleDetail("daily", bad).error ?? "", /HH:MM/, `"${bad}"`);
    }
  });

  test("weekly accepts short or full day names in any case", () => {
    assert.deepEqual(parseScheduleDetail("weekly", "Mon 09:30").schedule, { type: "weekly", weekday: 1, time: "09:30" });
    assert.deepEqual(parseScheduleDetail("weekly", "sunday 7:00").schedule, { type: "weekly", weekday: 0, time: "07:00" });
    assert.deepEqual(parseScheduleDetail("weekly", "FRI   18:45").schedule, { type: "weekly", weekday: 5, time: "18:45" });
  });

  test("weekly rejects an unknown day or a missing/invalid time", () => {
    for (const bad of ["Xyz 09:30", "Mon", "Mon 25:00", "09:30", ""]) {
      assert.match(parseScheduleDetail("weekly", bad).error ?? "", /Mon 09:30/, `"${bad}"`);
    }
  });

  test("monthly parses day-of-month + time", () => {
    assert.deepEqual(parseScheduleDetail("monthly", "15 9:30").schedule, { type: "monthly", day: 15, time: "09:30" });
    assert.deepEqual(parseScheduleDetail("monthly", "31 23:00").schedule, { type: "monthly", day: 31, time: "23:00" });
  });

  test("monthly rejects an out-of-range / non-integer day or a missing time", () => {
    for (const bad of ["0 09:30", "32 09:30", "1.5 09:30", "x 09:30", "15", "15 24:00"]) {
      assert.match(parseScheduleDetail("monthly", bad).error ?? "", /day-of-month/, `"${bad}"`);
    }
  });

  test("interval accepts whole minutes >= 1", () => {
    assert.deepEqual(parseScheduleDetail("interval", "90"), { schedule: { type: "interval", everyMinutes: 90 } });
    assert.deepEqual(parseScheduleDetail("interval", " 1 ").schedule, { type: "interval", everyMinutes: 1 });
  });

  test("interval rejects zero, negative, fractional and non-numeric input", () => {
    for (const bad of ["0", "-5", "1.5", "abc", ""]) {
      assert.match(parseScheduleDetail("interval", bad).error ?? "", /minutes/, `"${bad}"`);
    }
  });

  test("once parses a future local date-time into an ISO instant", () => {
    const r = parseScheduleDetail("once", "2099-01-15 10:30");
    assert.equal(r.error, undefined);
    assert.equal(r.schedule?.type, "once");
    assert.equal(Date.parse(r.schedule?.at ?? ""), at(2099, 1, 15, 10, 30));
  });

  test("once rejects past instants", () => {
    assert.match(parseScheduleDetail("once", "2000-01-01 10:00").error ?? "", /past/);
  });

  test("once asks for the format instead of guessing from free text", () => {
    // Date.parse would read these as 2001-09-01, 2030-01-01 and 2030-03-02.
    for (const bad of ["tomorrow at 9", "next friday 2030", "2030-02-30 10:00", "2030-13-01 10:00", "15 March 2030 10:00"]) {
      assert.match(parseScheduleDetail("once", bad).error ?? "", /YYYY-MM-DD HH:MM/, `"${bad}"`);
    }
  });

  test("an unknown schedule type is an error, not a throw", () => {
    assert.match(parseScheduleDetail("hourly" as ScheduleType, "1").error ?? "", /Unknown schedule type/);
  });
});

describe("computeNextRun", () => {
  describe("daily", () => {
    const daily: Schedule = { type: "daily", time: "09:30" };

    test("fires later today while the time is still ahead", () => {
      assert.equal(computeNextRun(daily, at(2026, 1, 7, 8, 0)), at(2026, 1, 7, 9, 30));
    });

    test("moves to tomorrow once the time has passed — or is exactly now", () => {
      assert.equal(computeNextRun(daily, at(2026, 1, 7, 10, 0)), at(2026, 1, 8, 9, 30));
      assert.equal(computeNextRun(daily, at(2026, 1, 7, 9, 30)), at(2026, 1, 8, 9, 30));
    });

    test("rolls over month and year boundaries", () => {
      assert.equal(computeNextRun({ type: "daily", time: "09:00" }, at(2026, 1, 31, 23, 0)), at(2026, 2, 1, 9, 0));
      assert.equal(computeNextRun({ type: "daily", time: "09:00" }, at(2026, 12, 31, 23, 0)), at(2027, 1, 1, 9, 0));
    });

    test("falls back to 09:00 when the stored time is missing or invalid", () => {
      assert.equal(computeNextRun({ type: "daily" }, at(2026, 1, 7, 8, 0)), at(2026, 1, 7, 9, 0));
      assert.equal(computeNextRun({ type: "daily", time: "99:99" }, at(2026, 1, 7, 8, 0)), at(2026, 1, 7, 9, 0));
    });
  });

  describe("weekly", () => {
    // 2026-01-07 is a Wednesday; 2026-01-12 and 2026-01-19 are Mondays.
    const monday: Schedule = { type: "weekly", weekday: 1, time: "09:30" };

    test("jumps ahead to the next matching weekday", () => {
      assert.equal(computeNextRun(monday, at(2026, 1, 7, 12, 0)), at(2026, 1, 12, 9, 30));
    });

    test("fires the same day when the time is still ahead", () => {
      assert.equal(computeNextRun(monday, at(2026, 1, 12, 8, 0)), at(2026, 1, 12, 9, 30));
    });

    test("waits a full week once that day's time has passed", () => {
      assert.equal(computeNextRun(monday, at(2026, 1, 12, 10, 0)), at(2026, 1, 19, 9, 30));
    });

    test("treats weekday 0 as Sunday (not as missing)", () => {
      const sunday: Schedule = { type: "weekly", weekday: 0, time: "07:00" };
      const next = computeNextRun(sunday, at(2026, 1, 7, 12, 0));
      assert.equal(next, at(2026, 1, 11, 7, 0));
      assert.equal(new Date(next!).getDay(), 0);
    });
  });

  describe("monthly", () => {
    test("fires this month while the day is still ahead", () => {
      assert.equal(computeNextRun({ type: "monthly", day: 15, time: "09:00" }, at(2026, 1, 10)), at(2026, 1, 15, 9, 0));
    });

    test("moves to next month once the day has passed", () => {
      assert.equal(computeNextRun({ type: "monthly", day: 15, time: "09:00" }, at(2026, 1, 20)), at(2026, 2, 15, 9, 0));
    });

    test("rolls into the next year", () => {
      assert.equal(computeNextRun({ type: "monthly", day: 15, time: "09:00" }, at(2026, 12, 20)), at(2027, 1, 15, 9, 0));
    });

    test("clamps day 31 to the last day of shorter months (incl. leap February)", () => {
      const eom: Schedule = { type: "monthly", day: 31, time: "09:00" };
      assert.equal(computeNextRun(eom, at(2026, 4, 5)), at(2026, 4, 30, 9, 0));
      assert.equal(computeNextRun(eom, at(2026, 1, 31, 10, 0)), at(2026, 2, 28, 9, 0));
      assert.equal(computeNextRun(eom, at(2028, 1, 31, 10, 0)), at(2028, 2, 29, 9, 0));
    });
  });

  describe("interval", () => {
    test("adds the interval to the reference time", () => {
      const from = at(2026, 1, 7, 12, 0);
      assert.equal(computeNextRun({ type: "interval", everyMinutes: 90 }, from), from + 90 * 60_000);
    });

    test("defaults to 60 minutes when unset", () => {
      const from = at(2026, 1, 7, 12, 0);
      assert.equal(computeNextRun({ type: "interval" }, from), from + HOUR);
    });
  });

  describe("once", () => {
    const iso = new Date(Date.UTC(2030, 5, 1, 12, 0)).toISOString();

    test("returns the instant while it is still in the future", () => {
      assert.equal(computeNextRun({ type: "once", at: iso }, Date.parse(iso) - 1), Date.parse(iso));
    });

    test("never fires again once reached, or when the instant is missing/invalid", () => {
      assert.equal(computeNextRun({ type: "once", at: iso }, Date.parse(iso)), undefined);
      assert.equal(computeNextRun({ type: "once", at: iso }, Date.parse(iso) + 1), undefined);
      assert.equal(computeNextRun({ type: "once" }, 0), undefined);
      assert.equal(computeNextRun({ type: "once", at: "not a date" }, 0), undefined);
    });
  });

  test("an unknown schedule type never fires", () => {
    assert.equal(computeNextRun({ type: "hourly" as ScheduleType }, Date.now()), undefined);
  });

  test("defaults the reference time to now", () => {
    const start = Date.now();
    const next = computeNextRun({ type: "interval", everyMinutes: 5 })!;
    assert.ok(next >= start + 5 * 60_000 && next <= Date.now() + 5 * 60_000);
  });
});

describe("computeNextRun across a DST change (America/New_York)", () => {
  // Pin a DST-observing zone so the transition is deterministic on any host.
  const originalTz = process.env.TZ;
  before(() => {
    process.env.TZ = "America/New_York";
  });
  after(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  test("daily keeps its wall-clock time when clocks spring forward", () => {
    // US DST starts Sun 2026-03-08 02:00, so the next 09:00 is only 23h away.
    const from = at(2026, 3, 7, 9, 0);
    const next = computeNextRun({ type: "daily", time: "09:00" }, from)!;
    assert.equal(new Date(next).getDate(), 8);
    assert.equal(new Date(next).getHours(), 9);
    assert.equal(next - from, 23 * HOUR);
  });

  test("weekly keeps its wall-clock time when clocks fall back", () => {
    // US DST ends Sun 2026-11-01 02:00, so Sat->Sat spans 7 days + 1h.
    const saturday: Schedule = { type: "weekly", weekday: 6, time: "09:00" };
    const from = at(2026, 10, 31, 9, 0);
    const next = computeNextRun(saturday, from)!;
    assert.equal(new Date(next).getHours(), 9);
    assert.equal(next - from, 7 * 24 * HOUR + HOUR);
  });
});

describe("describeSchedule", () => {
  test("renders a readable summary for each type", () => {
    assert.equal(describeSchedule({ type: "daily", time: "09:30" }), "daily at 09:30");
    assert.equal(describeSchedule({ type: "weekly", weekday: 1, time: "09:30" }), "weekly on Monday at 09:30");
    assert.equal(describeSchedule({ type: "weekly", weekday: 0, time: "07:00" }), "weekly on Sunday at 07:00");
    assert.equal(describeSchedule({ type: "monthly", day: 15, time: "09:00" }), "monthly on day 15 at 09:00");
    assert.equal(describeSchedule({ type: "interval", everyMinutes: 90 }), "every 90 min");
    assert.match(describeSchedule({ type: "once", at: new Date(Date.UTC(2030, 5, 1)).toISOString() }), /^once at \S/);
    assert.equal(describeSchedule({ type: "once" }), "once at ?");
    assert.equal(describeSchedule({ type: "hourly" as ScheduleType }), "unknown");
  });
});
