/** Bounded five-field cron parsing and IANA timezone scheduling, including DST folds/gaps. */
export class CronExpressionError extends Error {
  constructor(message: string) { super(message); this.name = "CronExpressionError"; }
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}
const CRON_ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *",
};
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronExpressionError(`Invalid cron field: ${part}`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const range = match[1].split("-").map(Number);
    const start = match[1] === "*" ? min : range[0];
    const end = match[1] === "*" || match[2] && range.length === 1 ? max : range[1] ?? start;
    if (!Number.isSafeInteger(step) || step <= 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < min || end > max || start > end) throw new CronExpressionError(`Cron field out of range: ${part}`);
    for (let n = start; n <= end; n += step) values.add(n);
  }
  if (!values.size) throw new CronExpressionError(`Empty cron field: ${field}`);
  return values;
}
export function parseCronExpression(expression: string): ParsedCron {
  if (typeof expression !== "string" || expression.length > 128) throw new CronExpressionError("Invalid cron expression length");
  const trimmed = expression.trim();
  const segments = (CRON_ALIASES[trimmed.toLowerCase()] ?? trimmed).split(/\s+/);
  if (segments.length !== 5) throw new CronExpressionError("Cron expression must have five fields");
  const [minute, hour, dom, month, dow] = segments;
  const daysOfWeek = parseField(dow, 0, 7);
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return { minutes: parseField(minute, 0, 59), hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dom, 1, 31), months: parseField(month, 1, 12), daysOfWeek,
    dayOfMonthWildcard: dom === "*", dayOfWeekWildcard: dow === "*" };
}

export function computeNextCronTime(expression: string, fromTimeMs = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): number {
  const parsed = parseCronExpression(expression);
  if (!Number.isFinite(fromTimeMs)) throw new CronExpressionError("Invalid reference time");
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch { throw new CronExpressionError(`Invalid timezone: ${timeZone}`); }
  const wallTime = (epoch: number): number => {
    const parts = Object.fromEntries(formatter.formatToParts(epoch).map(p => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  };
  const matchesDay = (date: Date): boolean => {
    if (!parsed.months.has(date.getUTCMonth() + 1)) return false;
    const dom = parsed.daysOfMonth.has(date.getUTCDate()), dow = parsed.daysOfWeek.has(date.getUTCDay());
    return parsed.dayOfMonthWildcard || parsed.dayOfWeekWildcard ? dom && dow : dom || dow;
  };
  const fixedWallSchedule = parsed.hours.size < 24 && parsed.minutes.size < 60;
  const firstOccurrence = (epoch: number, wall: number): number => {
    let first = epoch;
    for (let h = -36; h <= 36; h += 12) {
      const probe = epoch + h * 3600000;
      const candidate = wall - (wallTime(probe) - probe);
      if (candidate < first && wallTime(candidate) === wall) first = candidate;
    }
    return first;
  };
  const firstMinute = Math.floor(fromTimeMs / 60000) * 60000 + 60000;
  // Frequent schedules avoid enumerating a whole local calendar day.
  for (let i = 0; i < 180; i++) {
    const epoch = firstMinute + i * 60000, local = new Date(wallTime(epoch));
    if (matchesDay(local) && parsed.hours.has(local.getUTCHours()) && parsed.minutes.has(local.getUTCMinutes()) && (!fixedWallSchedule || firstOccurrence(epoch, local.getTime()) === epoch)) return epoch;
  }
  const firstDay = new Date(wallTime(fromTimeMs));
  firstDay.setUTCHours(0, 0, 0, 0);
  const hours = [...parsed.hours].sort((a, b) => a - b), minutes = [...parsed.minutes].sort((a, b) => a - b);
  for (let day = 0; day <= 366 * 5; day++) {
    const localDay = firstDay.getTime() + day * 86400000;
    if (!matchesDay(new Date(localDay))) continue;
    const offsets = new Set<number>();
    for (let h = -36; h <= 36; h += 12) {
      const epoch = localDay + h * 3600000;
      offsets.add(wallTime(epoch) - epoch);
    }
    let earliest = Infinity;
    for (const hour of hours) for (const minute of minutes) {
      const wall = localDay + hour * 3600000 + minute * 60000;
      for (const offset of offsets) {
        const epoch = wall - offset;
        if (epoch > fromTimeMs && epoch < earliest && wallTime(epoch) === wall && (!fixedWallSchedule || firstOccurrence(epoch, wall) === epoch)) earliest = epoch;
      }
    }
    if (Number.isFinite(earliest)) return earliest;
  }
  throw new CronExpressionError(`No execution time within five years: ${expression}`);
}
export function computeNextIntervalTime(intervalMs: number, fromTimeMs = Date.now()): number {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isSafeInteger(fromTimeMs + intervalMs)) throw new CronExpressionError("Interval must be a positive safe integer");
  return fromTimeMs + intervalMs;
}
export function isValidCronExpression(expression: string): boolean {
  try { parseCronExpression(expression); return true; } catch { return false; }
}
