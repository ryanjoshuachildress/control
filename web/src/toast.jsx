let toastTimer = null;
let setToastState = null;

export function initToast(setter) { setToastState = setter; }

export function toast(msg, isErr = false) {
  if (!setToastState) { console.warn('toast before init:', msg); return; }
  setToastState({ msg, isErr });
  clearTimeout(toastTimer);
  if (msg) {
    toastTimer = setTimeout(() => setToastState({ msg: '', isErr }), 3800);
  }
}

// The single toast element rendered by App.
export function ToastHost({ state }) {
  if (!state.msg) return null;
  return <div id="toast" className={'toast' + (state.isErr ? ' err' : '')}>{state.msg}</div>;
}