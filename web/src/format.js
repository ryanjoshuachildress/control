export function fmtDT(s) {
  if (!s) return '';
  const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(String(s) + 'T12:00:00Z');
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
export function fmtDateShort(key) {
  const parts = key.split('-');
  return `${parts[1]}/${parts[2]}`;
}
export const MOOD_WORDS = ['Terrible', 'Rough', 'Low', 'Poor', 'Meh', 'Okay', 'Good', 'Great', 'Lovely', 'Blissful'];
export const DOM_TITLES = ['Sir', 'Master', 'Daddy', 'Madam', 'Mistress', 'Goddess', 'Owner', 'Lord'];
export const SUB_TITLES = ['baby girl', 'pet', 'toy', 'slave', 'princess', 'kitten', 'little one', 'good girl'];
export const FREQ_LABEL = { daily: 'Daily · due midnight', weekly: 'Weekly · due Sunday midnight', monthly: 'Monthly · due end of month' };
export const LABEL_DUE = { daily: 'Due daily — deadline midnight', weekly: 'Due weekly — deadline Sunday midnight', monthly: 'Due monthly — deadline end of month' };
export const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
export const peopleLabel = (u) => (u && u.title) ? `${u.title} ${u.name}` : (u ? u.name : '');
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];