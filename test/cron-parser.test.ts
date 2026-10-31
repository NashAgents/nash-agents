import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCronExpression,
  computeNextCronTime,
  computeNextIntervalTime,
  isValidCronExpression,
} from "../src/cluster/scheduled/cron-parser.js";

describe("Cron Parser & Time Computation", () => {
  test("正确解析标准 5 段式 Cron 表达式与通配符", () => {
    const parsed = parseCronExpression("0 9 * * *");
    assert.ok(parsed.minutes.has(0));
    assert.strictEqual(parsed.minutes.size, 1);
    assert.ok(parsed.hours.has(9));
    assert.strictEqual(parsed.hours.size, 1);
    assert.strictEqual(parsed.daysOfMonth.size, 31);
    assert.strictEqual(parsed.months.size, 12);
  });

  test("正确支持步长 (step) 与区间 (range)", () => {
    const parsed = parseCronExpression("*/15 9-17 1,15 * 1-5");
    assert.deepStrictEqual(Array.from(parsed.minutes).sort((a, b) => a - b), [0, 15, 30, 45]);
    assert.ok(parsed.hours.has(9) && parsed.hours.has(17) && !parsed.hours.has(18));
    assert.ok(parsed.daysOfMonth.has(1) && parsed.daysOfMonth.has(15));
    assert.ok(parsed.daysOfWeek.has(1) && parsed.daysOfWeek.has(5) && !parsed.daysOfWeek.has(6));
  });

  test("正确支持常用预设别名", () => {
    assert.strictEqual(isValidCronExpression("@hourly"), true);
    assert.strictEqual(isValidCronExpression("@daily"), true);
    assert.strictEqual(isValidCronExpression("@weekly"), true);
    assert.strictEqual(isValidCronExpression("@monthly"), true);
    assert.strictEqual(isValidCronExpression("invalid_cron_syntax"), false);
  });

  test("确定性推算下一次执行时间戳 (nextRunTime)", () => {
    // 假设基准时间 2026-10-22 08:30:00 (本地时间)
    const baseDate = new Date("2026-10-22T08:30:00");
    const nextTimestamp = computeNextCronTime("0 9 * * *", baseDate.getTime());
    const nextDate = new Date(nextTimestamp);

    assert.strictEqual(nextDate.getHours(), 9);
    assert.strictEqual(nextDate.getMinutes(), 0);
    assert.strictEqual(nextDate.getSeconds(), 0);
    assert.strictEqual(nextDate.getDate(), 22);
  });

  test("若当天时刻已过，正确推算至次日", () => {
    // 假设基准时间 2026-10-22 09:30:00，计算每天9点
    const baseDate = new Date("2026-10-22T09:30:00");
    const nextTimestamp = computeNextCronTime("0 9 * * *", baseDate.getTime());
    const nextDate = new Date(nextTimestamp);

    assert.strictEqual(nextDate.getHours(), 9);
    assert.strictEqual(nextDate.getMinutes(), 0);
    assert.strictEqual(nextDate.getDate(), 23);
  });

  test("固定间隔时间推算", () => {
    const now = 1700000000000;
    const next = computeNextIntervalTime(3600000, now);
    assert.strictEqual(next, now + 3600000);
    assert.throws(() => computeNextIntervalTime(0, now));
  });
});
