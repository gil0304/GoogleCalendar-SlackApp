import { DateTime } from 'luxon';

export function mergeBusyIntervals(
  intervals: Array<{ start: DateTime; end: DateTime }>,
  rangeStart: DateTime,
  rangeEnd: DateTime
) {
  const sorted = intervals
    .map((interval) => ({
      start: interval.start < rangeStart ? rangeStart : interval.start,
      end: interval.end > rangeEnd ? rangeEnd : interval.end
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const merged: Array<{ start: DateTime; end: DateTime }> = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
    } else if (interval.end > last.end) {
      last.end = interval.end;
    }
  }
  return merged;
}

export function buildFreeIntervals(
  rangeStart: DateTime,
  rangeEnd: DateTime,
  busy: Array<{ start: DateTime; end: DateTime }>
) {
  if (busy.length === 0) {
    return [{ start: rangeStart, end: rangeEnd }];
  }

  const free: Array<{ start: DateTime; end: DateTime }> = [];
  let cursor = rangeStart;
  for (const interval of busy) {
    if (interval.start > cursor) {
      free.push({ start: cursor, end: interval.start });
    }
    if (interval.end > cursor) {
      cursor = interval.end;
    }
  }
  if (cursor < rangeEnd) {
    free.push({ start: cursor, end: rangeEnd });
  }
  return free;
}

export function listDays(startDate: DateTime, endDate: DateTime): DateTime[] {
  const days: DateTime[] = [];
  let cursor = startDate.startOf('day');
  const end = endDate.startOf('day');
  while (cursor <= end) {
    days.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

export function formatIntervalsShort(intervals: Array<{ start: DateTime; end: DateTime }>): string {
  if (intervals.length === 0) return 'なし';
  return intervals
    .map((interval) => `${interval.start.toFormat('HH:mm')} - ${interval.end.toFormat('HH:mm')}`)
    .join('\n');
}

export function findFirstAvailableSlot(
  days: DateTime[],
  timeRange: { start: { hour: number; minute: number }; end: { hour: number; minute: number } },
  durationMinutes: number,
  busy: Array<{ start: DateTime; end: DateTime }>
): DateTime | null {
  for (const day of days) {
    const dayStart = day.set({ hour: timeRange.start.hour, minute: timeRange.start.minute });
    const dayEnd = day.set({ hour: timeRange.end.hour, minute: timeRange.end.minute });
    if (dayEnd <= dayStart) continue;

    const mergedBusy = mergeBusyIntervals(busy, dayStart, dayEnd);
    const freeIntervals = buildFreeIntervals(dayStart, dayEnd, mergedBusy);
    for (const interval of freeIntervals) {
      if (interval.end.diff(interval.start, 'minutes').minutes >= durationMinutes) {
        return interval.start;
      }
    }
  }

  return null;
}
