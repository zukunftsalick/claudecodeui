/**
 * A small five-field cron reader for the schedules module: minute, hour, day
 * of month, month, day of week, read in an IANA time zone. It supports `*`,
 * numbers, ranges (`1-5`), steps (`*\/15`, `1-30/5`), lists (`1,15`) and month
 * and weekday names (`JAN`, `MON`). Day of week 7 also means Sunday. As in
 * standard cron, when both day fields are restricted a day matches either.
 *
 * Written here instead of pulling in a dependency because the module needs
 * only "is this minute a match" and "when is the next match".
 */

type CronField = { values: Set<number>; restricted: boolean };

/** A parsed expression; built by parseCron, read by nextCronRun. */
export type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Thrown for an expression or time zone that cannot be read; the service turns it into a 400. */
export class CronError extends Error {}

function readNumber(token: string, names: string[] | null, offset: number): number {
  const upper = token.toUpperCase();
  if (names) {
    const index = names.indexOf(upper);
    if (index >= 0) return index + offset;
  }
  if (!/^\d+$/.test(token)) throw new CronError(`"${token}" is not a number.`);
  return Number(token);
}

function parseField(raw: string, min: number, max: number, label: string, names: string[] | null = null, nameOffset = 0): CronField {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined || !rangePart) throw new CronError(`The ${label} field "${raw}" is not valid.`);
    const step = stepPart === undefined ? 1 : readNumber(stepPart, null, 0);
    if (step < 1) throw new CronError(`The ${label} step must be at least 1.`);

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [from, to] = rangePart.split('-');
      start = readNumber(from, names, nameOffset);
      end = readNumber(to, names, nameOffset);
    } else {
      start = readNumber(rangePart, names, nameOffset);
      // "5/15" means from 5 to the end in steps of 15, as in Vixie cron.
      end = stepPart === undefined ? start : max;
    }
    if (start < min || end > max || start > end) {
      throw new CronError(`The ${label} field "${raw}" is out of range (${min}-${max}).`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, restricted: raw !== '*' };
}

/** Used by the schedules service to validate and read a task's cron expression. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError('A schedule needs five fields: minute, hour, day of month, month and day of week.');
  }
  const dayOfWeek = parseField(fields[4], 0, 7, 'day of week', WEEKDAY_NAMES, 0);
  if (dayOfWeek.values.has(7)) {
    dayOfWeek.values.delete(7);
    dayOfWeek.values.add(0);
  }
  return {
    minute: parseField(fields[0], 0, 59, 'minute'),
    hour: parseField(fields[1], 0, 23, 'hour'),
    dayOfMonth: parseField(fields[2], 1, 31, 'day of month'),
    month: parseField(fields[3], 1, 12, 'month', MONTH_NAMES, 1),
    dayOfWeek,
  };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      });
    } catch {
      throw new CronError(`"${timeZone}" is not a time zone.`);
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Used by the schedules service to check a time zone before saving it. */
export function assertTimeZone(timeZone: string): void {
  formatterFor(timeZone);
}

type LocalParts = { month: number; day: number; hour: number; minute: number; weekday: number };

function localParts(date: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) parts[part.type] = part.value;
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_NAMES.indexOf(parts.weekday.toUpperCase().slice(0, 3)),
  };
}

function dayMatches(cron: ParsedCron, parts: LocalParts): boolean {
  const byMonthDay = cron.dayOfMonth.values.has(parts.day);
  const byWeekday = cron.dayOfWeek.values.has(parts.weekday);
  if (cron.dayOfMonth.restricted && cron.dayOfWeek.restricted) return byMonthDay || byWeekday;
  if (cron.dayOfMonth.restricted) return byMonthDay;
  if (cron.dayOfWeek.restricted) return byWeekday;
  return true;
}

const MINUTE_MS = 60_000;
// Five years of hours; "Feb 30" style expressions that never match stop here.
const MAX_STEPS = 5 * 366 * 24 + 60;

/**
 * The first minute strictly after `after` that the expression matches in
 * `timeZone`, or null if none comes within five years.
 *
 * Used by the schedules service to set each task's next run.
 */
export function nextCronRun(cron: ParsedCron, timeZone: string, after: Date): Date | null {
  let time = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const parts = localParts(new Date(time), timeZone);
    if (!cron.month.values.has(parts.month) || !dayMatches(cron, parts) || !cron.hour.values.has(parts.hour)) {
      // Nothing in this local hour can match; go to the top of the next one.
      time += (60 - parts.minute) * MINUTE_MS;
      continue;
    }
    if (!cron.minute.values.has(parts.minute)) {
      time += MINUTE_MS;
      continue;
    }
    return new Date(time);
  }
  return null;
}

const pad = (value: number): string => String(value).padStart(2, '0');
const WEEKDAY_LABELS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/**
 * Plain words for the common shapes ("Every day at 08:00", "Mondays at 10:13",
 * "Every 15 minutes"), or the expression itself for anything else.
 *
 * Used by the schedules service for the Schedules tab's list.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const isNumber = (value: string) => /^\d+$/.test(value);

  if (month === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    if (/^\*\/\d+$/.test(minute) && hour === '*') return `Every ${minute.slice(2)} minutes`;
    if (isNumber(minute) && hour === '*') return `Every hour at :${pad(Number(minute))}`;
    if (isNumber(minute) && isNumber(hour)) return `Every day at ${pad(Number(hour))}:${pad(Number(minute))}`;
  }
  if (month === '*' && dayOfMonth === '*' && isNumber(minute) && isNumber(hour)) {
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    if (dayOfWeek === '1-5') return `Weekdays at ${time}`;
    if (/^[0-7](,[0-7])*$/.test(dayOfWeek)) {
      const days = [...new Set(dayOfWeek.split(',').map((day) => Number(day) % 7))].map((day) => WEEKDAY_LABELS[day]);
      return `${days.join(', ')} at ${time}`;
    }
  }
  if (month === '*' && dayOfWeek === '*' && isNumber(dayOfMonth) && isNumber(minute) && isNumber(hour)) {
    return `Monthly on day ${dayOfMonth} at ${pad(Number(hour))}:${pad(Number(minute))}`;
  }
  return expression;
}
