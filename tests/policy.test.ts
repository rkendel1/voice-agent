import assert from "node:assert/strict";
import { test } from "node:test";
import { callAdvances, freeSlots, inQuietHours, isOpen, localParts, localToEpoch, normalizePhone, smsAdvances, smsKeyword } from "../feltkit/_policy.js";
import { parseDay, parseTime } from "../gateway/brain/deterministic.js";

const NY = "America/New_York";

test("local time ↔ instant, across a DST change", () => {
  for (const [date, time] of [["2026-03-07", "10:00"], ["2026-03-09", "10:00"], ["2026-11-02", "09:30"], ["2026-07-04", "23:45"]] as const) {
    const at = localToEpoch(date, time, NY);
    assert.deepEqual([localParts(at, NY).date, localParts(at, NY).time], [date, time]);
  }
  assert.equal(localToEpoch("2026-07-01", "12:00", NY) - localToEpoch("2026-07-01", "12:00", "UTC"), 4 * 3600_000);
});

test("opening hours and quiet hours (wrapping midnight)", () => {
  const hours = [{ day: "mon" as const, open: "09:00", close: "17:00" }];
  assert.equal(isOpen(hours, NY, localToEpoch("2026-11-09", "10:00", NY)), true); // Monday
  assert.equal(isOpen(hours, NY, localToEpoch("2026-11-09", "17:00", NY)), false);
  assert.equal(isOpen(hours, NY, localToEpoch("2026-11-10", "10:00", NY)), false); // Tuesday
  assert.equal(inQuietHours("21:00", "08:00", NY, localToEpoch("2026-11-09", "22:00", NY)), true);
  assert.equal(inQuietHours("21:00", "08:00", NY, localToEpoch("2026-11-09", "07:59", NY)), true);
  assert.equal(inQuietHours("21:00", "08:00", NY, localToEpoch("2026-11-09", "12:00", NY)), false);
  assert.equal(inQuietHours("00:00", "00:00", NY, Date.now()), false, "equal start and end: no quiet hours");
});

test("free slots: inside hours, on boundaries, not past, not booked", () => {
  const hours = [{ day: "mon" as const, open: "09:00", close: "11:00" }];
  const now = localToEpoch("2026-11-09", "09:10", NY);
  const slots = freeSlots({ hours, timezone: NY, date: "2026-11-09", minutes: 30, booked: new Set(["2026-11-09T10:00"]), now });
  assert.deepEqual(slots.map((s) => s.time), ["09:30", "10:30"]);
});

test("STOP/START/HELP keywords, phone numbers, forward-only statuses", () => {
  assert.equal(smsKeyword(" Stop. "), "stop");
  assert.equal(smsKeyword("UNSUBSCRIBE"), "stop");
  assert.equal(smsKeyword("please stop texting me"), null, "only the exact keyword is a command");
  assert.equal(smsKeyword("start"), "start");
  assert.equal(normalizePhone("(415) 555-0100"), "+14155550100");
  assert.equal(normalizePhone("12"), null);
  assert.equal(smsAdvances("delivered", "sent"), false);
  assert.equal(smsAdvances("sent", "delivered"), true);
  assert.equal(callAdvances("completed", "ringing"), false);
  assert.equal(callAdvances("ringing", "in-progress"), true);
});

test("the scripted agent's date and time understanding", () => {
  const today = "2026-11-05"; // a Thursday
  assert.equal(parseDay("tomorrow please", today), "2026-11-06");
  assert.equal(parseDay("on Monday", today), "2026-11-09");
  assert.equal(parseDay("thursday", today), "2026-11-12", "a weekday name never means today");
  assert.equal(parseDay("today", today), today);
  assert.equal(parseTime("2pm"), "14:00");
  assert.equal(parseTime("at 2:30 pm"), "14:30");
  assert.equal(parseTime("10 am"), "10:00");
  assert.equal(parseTime("at 3"), "15:00");
  assert.equal(parseTime("noon"), "12:00");
  assert.equal(parseTime("I have 2 kids"), null, "a bare number is not a time");
});
