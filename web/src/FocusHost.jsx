import { useEffect } from 'react';

// Port of applyFocus(): after a page renders, scroll the referenced item into
// view and flash it. The anchor is either the comments block of the referenced
// item (data-comment-subject/id, same ids as comment threads) or an explicit
// data-focus marker. `focusSpec` looks like "task:<id>".
export default function FocusHost({ focusSpec }) {
  useEffect(() => {
    if (!focusSpec) return;
    const colon = String(focusSpec).indexOf(':');
    if (colon === -1) return;
    const subject = String(focusSpec).slice(0, colon);
    const id = String(focusSpec).slice(colon + 1);
    const anchor =
      document.querySelector(`.comments[data-comment-subject="${subject}"][data-comment-id="${id}"]`) ||
      document.querySelector(`[data-focus="${subject}:${id}"]`);
    if (!anchor) return;
    const item = anchor.closest('.item') || anchor.closest('.card');
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'start' });
      item.classList.add('focus-flash');
      setTimeout(() => item.classList.remove('focus-flash'), 4000);
    }
  }, [focusSpec]);
  return null;
}