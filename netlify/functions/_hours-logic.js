// Shared hours calculation logic.
// Rules (per Joe, June 2026):
//   - Saturday or Sunday hours: always overtime, regardless of weekly total.
//   - Holiday hours: tracked separately as holiday pay, not folded into OT.
//   - Weekday (Mon-Fri, non-holiday) hours: first 40/week regular, remainder OT.
//   - Weekly OT threshold only applies to weekday non-holiday hours, since
//     weekend hours are already OT and holiday hours are their own bucket.
//   - Lunch/break segments (identified by job location name containing
//     "lunch" or "break", case-insensitive - see isBreakLocationName) are
//     paid for their first 30 minutes per segment, with anything beyond
//     that in the SAME segment unpaid entirely (not regular, not OT, not
//     counted anywhere). Each break segment gets its own independent
//     30-minute allowance - a day with two 20-minute breaks has both
//     fully paid, since neither individually exceeds 30 minutes.

const BREAK_PAID_MINUTES_CAP = 30;

// True if a job location's name should be treated as a lunch/break
// location. Matches by substring, case-insensitive, per explicit
// decision to avoid needing a dedicated checkbox/flag on job_locations.
// Known tradeoff: a job site literally named e.g. "Lunch Room" or
// "Breakwater Marina" would also match and get the break-pay treatment.
function isBreakLocationName(name) {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return normalized.includes('lunch') || normalized.includes('break');
}

function timeStringToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function rawHoursForEntry(timeIn, timeOut) {
  const inMin = timeStringToMinutes(timeIn);
  const outMin = timeStringToMinutes(timeOut);
  if (inMin === null || outMin === null) return 0;
  let diff = outMin - inMin;
  if (diff < 0) diff += 24 * 60; // overnight shift safety
  return Math.max(0, diff / 60);
}

// Converts a (date, time) pair into an absolute minute count, used only
// to compare relative ordering between segments - not real calendar math,
// so DST and similar concerns don't apply. Days-since-epoch * 1440 keeps
// every timestamp's relative position correct regardless of which date
// it falls on, which is what overlap detection across day boundaries
// (overnight shifts) actually needs.
function toAbsoluteMinutes(dateStr, timeStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const daysSinceEpoch = Math.floor(d.getTime() / 86400000);
  const mins = timeStringToMinutes(timeStr);
  if (mins === null) return null;
  return daysSinceEpoch * 1440 + mins;
}

// Normalizes one segment to an absolute {start, end} range. If time_out
// is earlier than (or equal to) time_in, the segment is treated as
// crossing into the next calendar day - same convention as
// rawHoursForEntry above, so overlap checks and hours calculations agree
// about what counts as an overnight shift.
function normalizeSegmentRange(entryDate, timeIn, timeOut) {
  const start = toAbsoluteMinutes(entryDate, timeIn);
  let end = toAbsoluteMinutes(entryDate, timeOut);
  if (start === null || end === null) return null;
  if (end <= start) end += 24 * 60;
  return { start, end };
}

// True if two segments' time ranges overlap at all. Touching exactly
// (one ends precisely when the other starts) does NOT count as overlap.
function rangesOverlap(rangeA, rangeB) {
  if (!rangeA || !rangeB) return false;
  return rangeA.start < rangeB.end && rangeB.start < rangeA.end;
}

// Given a new/edited segment and a list of other existing segments (each
// with entry_date, time_in, time_out), returns the first existing segment
// that overlaps with it, or null if none do. Excludes segments missing
// either time field, since those can't be range-checked.
function findOverlappingSegment(newSegment, otherSegments) {
  const newRange = normalizeSegmentRange(newSegment.entryDate, newSegment.timeIn, newSegment.timeOut);
  if (!newRange) return null;

  for (const seg of otherSegments) {
    if (!seg.time_in || !seg.time_out) continue;
    const segRange = normalizeSegmentRange(seg.entry_date, seg.time_in, seg.time_out);
    if (rangesOverlap(newRange, segRange)) return seg;
  }
  return null;
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// entries: array of { entry_date, hours_worked, is_holiday, hours_type } for ONE employee,
// covering ONE Sun-Sat week, already sorted or not (order doesn't matter).
// Returns each entry annotated with computed bucket, plus week totals.
function classifyWeek(entries) {
  // Holiday and PTO hours never count toward the 40hr weekday threshold.
  const weekdayRegularCandidates = entries.filter(
    e => !isWeekend(e.entry_date) && !e.is_holiday && e.hours_type !== 'pto'
  );

  // Sort by date so OT spills onto the later hours of the week, not the earlier ones.
  weekdayRegularCandidates.sort((a, b) => a.entry_date.localeCompare(b.entry_date));

  let runningWeekdayHours = 0;
  const results = [];

  for (const e of entries) {
    const weekend = isWeekend(e.entry_date);
    // Accept either shape: a nested job_locations object (from a Supabase
    // join, e.g. .select('*, job_locations(name)')) or a flat
    // job_location_name field, so this works correctly regardless of
    // exactly how the caller's query was written - several different
    // functions call classifyWeek with queries that joined this
    // differently (or, in one case, not at all - that gap is exactly why
    // this is read defensively rather than assumed to be present).
    const locationName = e.job_locations?.name || e.job_location_name || null;
    const isBreak = isBreakLocationName(locationName);
    let bucket;
    let regularPortion = 0;
    let otPortion = 0;
    let unpaidBreakPortion = 0;

    // Break/lunch segments: only the first 30 minutes of THIS segment is
    // payable. Anything beyond that, in this same segment, is dropped
    // entirely - it doesn't count toward regular, OT, or anything else.
    // This check happens before the weekend/holiday/OT logic below, since
    // a break taken on a weekend should still only pay 30 minutes of it,
    // not get treated as full weekend OT.
    let payableHours = e.hours_worked;
    if (isBreak) {
      const capHours = BREAK_PAID_MINUTES_CAP / 60;
      if (e.hours_worked > capHours) {
        unpaidBreakPortion = e.hours_worked - capHours;
        payableHours = capHours;
      }
    }

    if (e.hours_type === 'pto') {
      bucket = 'pto';
    } else if (e.is_holiday) {
      bucket = 'holiday';
    } else if (weekend) {
      bucket = 'overtime';
      otPortion = payableHours;
    } else if (isBreak) {
      // Lunch and break segments are always regular pay regardless of
      // where the employee sits in the weekly total - they can never
      // push someone into overtime. They do NOT add to runningWeekdayHours
      // so a 40-hour week + 0.5h lunch = 40h regular work + 0.5h regular
      // lunch, not 40h regular + 0.5h overtime.
      regularPortion = payableHours;
      bucket = 'regular';
    } else {
      const before = runningWeekdayHours;
      runningWeekdayHours += payableHours;
      if (before >= 40) {
        otPortion = payableHours;
      } else if (runningWeekdayHours > 40) {
        regularPortion = 40 - before;
        otPortion = runningWeekdayHours - 40;
      } else {
        regularPortion = payableHours;
      }
      bucket = otPortion > 0 && regularPortion > 0 ? 'split' : (otPortion > 0 ? 'overtime' : 'regular');
    }

    results.push({
      ...e,
      bucket,
      is_break: isBreak,
      unpaid_break_hours: unpaidBreakPortion,
      regular_hours: bucket === 'split' ? regularPortion : (bucket === 'regular' ? payableHours : 0),
      overtime_hours: bucket === 'split' ? otPortion : (bucket === 'overtime' ? payableHours : 0),
      holiday_hours: bucket === 'holiday' ? payableHours : 0,
      pto_hours: bucket === 'pto' ? payableHours : 0,
      is_lunch: isBreak,
    });
  }

  const totals = results.reduce((acc, r) => {
    acc.regular += r.regular_hours;
    acc.overtime += r.overtime_hours;
    acc.holiday += r.holiday_hours;
    acc.pto += r.pto_hours;
    acc.lunch += r.is_lunch ? r.regular_hours : 0;
    return acc;
  }, { regular: 0, overtime: 0, holiday: 0, pto: 0, lunch: 0 });

  totals.weekly_total = totals.regular + totals.overtime + totals.holiday + totals.pto;
  totals.regular_ex_lunch = Math.max(0, totals.regular - totals.lunch);

  return { entries: results, totals };
}

// Determines which foreman should approve a given employee's segments
// for one week: sums hours_worked grouped by foreman_id (falling back to
// defaultForemanId for any segment that didn't specify one), and returns
// whichever foreman has the highest total. This means the SAME employee
// could have a different approver from one week to the next, depending
// on who they actually worked under that week - this is intentional,
// confirmed explicitly, not an oversight.
// Tiebreak: if two or more foremen are tied for the highest total, and
// the employee's default assigned foreman is one of the tied foremen,
// the default wins the tie. If the default isn't involved in the tie,
// this picks deterministically (whichever tied foreman appears first
// after sorting) rather than randomly - documented assumption, not
// separately confirmed, since true ties are expected to be rare.
function determineWeeklyApprovalForeman(segments, defaultForemanId) {
  const totalsByForeman = {};
  for (const seg of segments) {
    const fid = seg.foreman_id || defaultForemanId;
    if (!fid) continue;
    totalsByForeman[fid] = (totalsByForeman[fid] || 0) + Number(seg.hours_worked || 0);
  }

  const entries = Object.entries(totalsByForeman);
  if (entries.length === 0) return null;

  entries.sort((a, b) => b[1] - a[1]);

  const topTotal = entries[0][1];
  const tiedAtTop = entries.filter(([, total]) => total === topTotal);

  if (tiedAtTop.length > 1 && defaultForemanId) {
    const defaultIsTied = tiedAtTop.some(([fid]) => fid === defaultForemanId);
    if (defaultIsTied) return defaultForemanId;
  }

  return entries[0][0];
}

// For Leave (PTO) requests, which are submitted before any work happens
// for the dates in question, there's no week of segments to tally. The
// confirmed rule instead: route to whoever was the foreman on the
// employee's single most recently logged segment overall (any week),
// falling back to their default assigned foreman if they have no
// segments logged yet at all. This is computed and LOCKED IN once, at
// submission time - it does not get recalculated while a request sits
// pending, even if the employee logs new segments under a different
// foreman in the meantime.
function findMostRecentSegmentForeman(segments, defaultForemanId) {
  if (!segments || segments.length === 0) return defaultForemanId || null;
  const sorted = segments.slice().sort((a, b) => {
    if (a.entry_date !== b.entry_date) return b.entry_date.localeCompare(a.entry_date);
    return (b.time_in || '').localeCompare(a.time_in || '');
  });
  return sorted[0].foreman_id || defaultForemanId || null;
}

// Returns true if dateStr (YYYY-MM-DD) falls on one of the six company
// recognized holidays. Computed dynamically for any year so no annual
// database seeding is needed.
//
// Holidays:
//   New Year's Day    - January 1
//   Memorial Day      - Last Monday of May
//   Independence Day  - July 4
//   Labor Day         - First Monday of September
//   Thanksgiving      - Fourth Thursday of November
//   Christmas Day     - December 25
function isHoliday(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);

  // Fixed-date holidays
  if (month === 1 && day === 1) return true;   // New Year's Day
  if (month === 7 && day === 4) return true;   // Independence Day
  if (month === 12 && day === 25) return true; // Christmas Day

  // Last Monday of May (Memorial Day)
  if (month === 5) {
    const d = new Date(Date.UTC(year, 4, day)); // month is 0-indexed
    if (d.getUTCDay() === 1) { // it's a Monday
      // Check it's the last Monday: next Monday would be in June
      const nextMonday = new Date(Date.UTC(year, 4, day + 7));
      if (nextMonday.getUTCMonth() !== 4) return true;
    }
  }

  // First Monday of September (Labor Day)
  if (month === 9) {
    const d = new Date(Date.UTC(year, 8, day));
    if (d.getUTCDay() === 1 && day <= 7) return true;
  }

  // Fourth Thursday of November (Thanksgiving)
  if (month === 11) {
    const d = new Date(Date.UTC(year, 10, day));
    if (d.getUTCDay() === 4) { // it's a Thursday
      // Count which Thursday this is
      const thursdayNum = Math.ceil(day / 7);
      if (thursdayNum === 4) return true;
    }
  }

  return false;
}

module.exports = { rawHoursForEntry, isWeekend, isHoliday, classifyWeek, timeStringToMinutes, findOverlappingSegment, normalizeSegmentRange, rangesOverlap, isBreakLocationName, determineWeeklyApprovalForeman, findMostRecentSegmentForeman };
