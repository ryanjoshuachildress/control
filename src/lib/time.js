// Timezone-aware period helpers.
// Deadlines per user's own IANA timezone:
//   daily  -> local midnight
//   weekly -> local midnight Sunday (weeks run Monday..Sunday)
//   monthly-> local midnight on the last day of the month

function tzParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return p;
}

// Offset of the timezone from UTC, in ms, at the given instant.
function tzOffsetMs(date, tz) {
  const p = tzParts(date, tz);
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)
  );
  return asUTC - date.getTime();
}

// Instant (Date) of a wall-clock time in the timezone. hour=24 means next-day midnight.
function instantOfDay(tz, y, m, d, hour = 0) {
  const guess = Date.UTC(y, m - 1, d, hour) - tzOffsetMs(new Date(Date.UTC(y, m - 1, d, 12)), tz);
  const refined = Date.UTC(y, m - 1, d, hour) - tzOffsetMs(new Date(guess), tz);
  return new Date(refined);
}

// Current local date in the tz, as YYYY-MM-DD.
function currentDateKey(now, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

// Shift a YYYY-MM-DD key by N days (noon-UTC trick avoids DST edges).
function shiftDateKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12) + days * 86400000;
  const dt = new Date(t);
  const sy = dt.getUTCFullYear(), sm = dt.getUTCMonth() + 1, sd = dt.getUTCDate();
  return `${sy}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
}

// Sunday ending the current week (Monday..Sunday), as YYYY-MM-DD.
function currentSundayKey(now, tz) {
  const key = currentDateKey(now, tz);
  const [y, m, d] = key.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const daysToSunday = (7 - weekday) % 7;
  return shiftDateKey(key, daysToSunday);
}

function currentPeriodKey(now, tz, frequency) {
  if (frequency === 'daily') return currentDateKey(now, tz);
  if (frequency === 'weekly') return currentSundayKey(now, tz);
  const key = currentDateKey(now, tz);
  return key.slice(0, 7); // YYYY-MM
}

function previousPeriodKey(now, tz, frequency) {
  if (frequency === 'daily') {
    return shiftDateKey(currentDateKey(now, tz), -1);
  }
  if (frequency === 'weekly') {
    return shiftDateKey(currentSundayKey(now, tz), -7);
  }
  const [y, m] = currentDateKey(now, tz).split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

// The instant the given period ends (past this => missed).
// daily key:   YYYY-MM-DD   -> next-day midnight
// weekly key:  YYYY-MM-DD (a Sunday) -> that Sunday midnight
// monthly key: YYYY-MM      -> midnight of the 1st of the next month
function deadlineInstant(tz, frequency, key) {
  if (frequency === 'monthly') {
    const [y, m] = key.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return instantOfDay(tz, ny, nm, 1, 0);
  }
  const [y, m, d] = key.split('-').map(Number);
  return instantOfDay(tz, y, m, d, 24);
}

// Instant a specific YYYY-MM-DD due date ends: end of that day (local midnight).
// Used for tasks with a Dom-set due date that overrides the frequency cycle.
function dueDateInstant(tz, dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return instantOfDay(tz, y, m, d, 24);
}

function isPastDeadline(now, tz, frequency, key) {
  return now.getTime() >= deadlineInstant(tz, frequency, key).getTime();
}

// SQLite `datetime('now')` text ("YYYY-MM-DD HH:MM:SS") parsed as UTC.
function parseSqliteTimestamp(s) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.valueOf()) ? null : d;
}

module.exports = {
  currentPeriodKey,
  previousPeriodKey,
  deadlineInstant,
  dueDateInstant,
  currentDateKey,
  isPastDeadline,
  parseSqliteTimestamp,
  shiftDateKey
};