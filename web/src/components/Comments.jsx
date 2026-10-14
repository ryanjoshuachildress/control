import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import { fmtDT } from '../format';
import { useUser } from '../user';
import { toast } from '../toast';
import { useRoute } from '../router';

// Comment thread box. Rendered on every commentable item with the same
// data-comment-subject/data-comment-id attributes the email deep links point
// at (?focus=subject:id — FocusHost anchors, loadComments used to read them).
// Opens automatically when this exact thread is the arrival focus.
export default function Comments({ subject, id, count }) {
  const { user } = useUser();
  const { focus } = useRoute();
  const isDom = user && user.role === 'dom';
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState(null);
  const [n, setN] = useState(count || 0);
  const [body, setBody] = useState('');
  const boxRef = useRef(null);

  // Auto-open when this thread is the referenced one (one-shot per navigation).
  useEffect(() => {
    if (!focus || open) return;
    const colon = String(focus).indexOf(':');
    if (colon !== -1 && String(focus).slice(0, colon) === subject && String(focus).slice(colon + 1) === id) {
      openBox();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  async function openBox() {
    setOpen(true);
    try {
      const d = await api(`/comments/${subject}/${id}`);
      setComments(d.comments);
      setN(d.comments.length || n);
    } catch (e) { setComments({ __err: e.message }); }
  }

  async function post() {
    try {
      await api(`/comments/${subject}/${id}`, { method: 'POST', body: { body } });
      const d = await api(`/comments/${subject}/${id}`);
      setComments(d.comments);
      setN(d.comments.length);
      setBody('');
    } catch (e) { toast(e.message, true); }
  }

  async function del(commentId) {
    try {
      await api(`/comments/id/${commentId}`, { method: 'DELETE' });
      const d = await api(`/comments/${subject}/${id}`);
      setComments(d.comments);
    } catch (e) { toast(e.message, true); }
  }

  return (
    <div className="comments" data-comment-subject={subject} data-comment-id={id} ref={boxRef}>
      <button className="small ghost" data-action="toggle-comments" onClick={() => (open ? setOpen(false) : openBox())}>
        💬 Comments{n ? ` · ${n}` : ''}
      </button>
      {open && (
        <>
          <div className="comment-list">
            {comments === null && <div className="tiny" style={{ padding: '4px 6px' }}>Loading…</div>}
            {comments && comments.__err && <div className="tiny" style={{ padding: '4px 6px' }}>{comments.__err}</div>}
            {comments && !comments.__err && !comments.length && (
              <div className="empty" style={{ padding: 8 }}>No comments yet.</div>
            )}
            {comments && !comments.__err && comments.map(c => (
              <div className="comment" key={c.id}>
                <div className="comment-head">
                  <b>{c.author_name}</b>
                  {c.author_title ? <span>· {c.author_title}</span> : null}
                  <span>{fmtDT(c.created_at)}</span>
                  {c.can_delete && isDom && (
                    <button className="small ghost comment-del" onClick={() => del(c.id)}>delete</button>
                  )}
                </div>
                <div className="comment-body">{c.body}</div>
              </div>
            ))}
          </div>
          <form className="comment-form" data-form="comment" onSubmit={(e) => { e.preventDefault(); post(); }}>
            <label style={{ margin: '10px 0' }} className="f">
              <textarea name="body" maxLength={2000} required placeholder="Write a comment…" value={body}
                onChange={e => setBody(e.target.value)} />
            </label>
            <button className="primary small" type="submit">Post comment</button>
          </form>
        </>
      )}
    </div>
  );
}