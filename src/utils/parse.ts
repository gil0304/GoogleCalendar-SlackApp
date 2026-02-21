import { DateTime } from 'luxon';

export function parseDateParts(dateStr: string): { year?: number; month: number; day: number; hasYear: boolean } | null {
  const ymd = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    return {
      year: Number(ymd[1]),
      month: Number(ymd[2]),
      day: Number(ymd[3]),
      hasYear: true
    };
  }

  const md = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (md) {
    return {
      month: Number(md[1]),
      day: Number(md[2]),
      hasYear: false
    };
  }

  return null;
}

export function parseDate(dateStr: string, now: DateTime): { year: number; month: number; day: number } | null {
  const parts = parseDateParts(dateStr);
  if (!parts) return null;
  let year = parts.hasYear ? parts.year! : now.year;
  const candidate = DateTime.fromObject(
    { year, month: parts.month, day: parts.day },
    { zone: now.zoneName ?? 'UTC' }
  );
  if (!parts.hasYear && candidate.isValid && candidate < now.startOf('day')) {
    year += 1;
  }
  return { year, month: parts.month, day: parts.day };
}

export function parseDateRange(
  dateStr: string,
  now: DateTime
): { startDate: DateTime; endDate: DateTime } | null {
  let startToken: string | null = null;
  let endToken: string | null = null;

  if (dateStr.includes('~')) {
    const [start, end] = dateStr.split('~');
    startToken = start;
    endToken = end;
  } else if (dateStr.includes('..')) {
    const [start, end] = dateStr.split('..');
    startToken = start;
    endToken = end;
  } else {
    const mdRange = dateStr.match(/^(\d{1,2}[\/\-]\d{1,2})-(\d{1,2}[\/\-]\d{1,2})$/);
    if (mdRange) {
      startToken = mdRange[1];
      endToken = mdRange[2];
    }
  }

  if (startToken && endToken) {
    const startParts = parseDateParts(startToken);
    const endParts = parseDateParts(endToken);
    if (!startParts || !endParts) return null;

    let startYear = startParts.hasYear ? startParts.year! : now.year;
    let startDate = DateTime.fromObject(
      { year: startYear, month: startParts.month, day: startParts.day },
      { zone: now.zoneName ?? 'UTC' }
    );
    if (!startParts.hasYear && startDate.isValid && startDate < now.startOf('day')) {
      startYear += 1;
      startDate = DateTime.fromObject(
        { year: startYear, month: startParts.month, day: startParts.day },
        { zone: now.zoneName ?? 'UTC' }
      );
    }

    let endYear = endParts.hasYear ? endParts.year! : startYear;
    let endDate = DateTime.fromObject(
      { year: endYear, month: endParts.month, day: endParts.day },
      { zone: now.zoneName ?? 'UTC' }
    );
    if (!endParts.hasYear && endDate.isValid && endDate < startDate) {
      endYear += 1;
      endDate = DateTime.fromObject(
        { year: endYear, month: endParts.month, day: endParts.day },
        { zone: now.zoneName ?? 'UTC' }
      );
    }

    if (!startDate.isValid || !endDate.isValid) return null;
    return { startDate: startDate.startOf('day'), endDate: endDate.startOf('day') };
  }

  const single = parseDate(dateStr, now);
  if (!single) return null;
  const date = DateTime.fromObject(
    { year: single.year, month: single.month, day: single.day },
    { zone: now.zoneName ?? 'UTC' }
  ).startOf('day');
  if (!date.isValid) return null;
  return { startDate: date, endDate: date };
}

export function parseTime(timeStr: string): { hour: number; minute: number } | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function parseTimeRange(rangeStr: string): { start: { hour: number; minute: number }; end: { hour: number; minute: number } } | null {
  const match = rangeStr.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const start = parseTime(match[1]);
  const end = parseTime(match[2]);
  if (!start || !end) return null;
  return { start, end };
}

export function isValidTimeRange(range: { start: { hour: number; minute: number }; end: { hour: number; minute: number } }): boolean {
  if (range.end.hour > range.start.hour) return true;
  if (range.end.hour === range.start.hour && range.end.minute > range.start.minute) return true;
  return false;
}

export function formatTimePart(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

export function formatTimeRange(range: { start: { hour: number; minute: number }; end: { hour: number; minute: number } }): string {
  return `${formatTimePart(range.start)}-${formatTimePart(range.end)}`;
}

export function parseDuration(durationStr: string): number | null {
  const plain = durationStr.match(/^(\d+)$/);
  if (plain) return Number(plain[1]);

  const match = durationStr.match(/^(\d+)(m|h)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  return unit === 'h' ? value * 60 : value;
}
