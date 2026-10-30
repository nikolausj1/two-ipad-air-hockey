// WebSocket wrapper with automatic reconnect. Messages are JSON objects with
// a `t` field. Pairing messages (host/join/hosted/joined/...) are handled by
// the server; everything else is relayed to the other iPad as-is.
//
// The socket reconnects by itself (0.5 s, 1 s, 2 s, 4 s, then every 5 s).
// `onOpen(isReconnect)` fires after every successful (re)connect, which is
// where the caller re-sends its host/join message.

const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];

export function connect({ onOpen, onMessage, onClose, onState } = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;
  let everOpen = false;
  let state = 'connecting'; // 'connecting' | 'open' | 'reconnecting' | 'closed'

  function setState(s) {
    if (state === s) return;
    state = s;
    if (onState) onState(s);
  }

  function schedule() {
    if (closed || timer) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  function open() {
    if (closed || ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let sock;
    try {
      sock = new WebSocket(`${proto}://${location.host}`);
    } catch {
      if (onClose) onClose();
      schedule();
      return;
    }
    ws = sock;
    setState(everOpen ? 'reconnecting' : 'connecting');

    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      const again = everOpen;
      everOpen = true;
      attempt = 0;
      setState('open');
      if (onOpen) onOpen(again);
    });

    sock.addEventListener('message', (ev) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (onMessage) onMessage(msg);
    });

    sock.addEventListener('close', () => {
      if (ws !== sock) return; // superseded by reset()
      ws = null;
      if (closed) return setState('closed');
      setState('reconnecting');
      if (onClose) onClose();
      schedule();
    });

    // An error is always followed by a close event, which does the work.
    sock.addEventListener('error', () => {});
  }

  /** Reconnect right now (back online, tab visible again, watchdog). */
  function nudge() {
    if (closed || ws) return;
    clearTimeout(timer);
    timer = null;
    attempt = 0;
    open();
  }

  /** Throw away the current socket (it looks dead) and reconnect immediately. */
  function reset() {
    if (closed) return;
    const old = ws;
    ws = null;
    if (old) {
      try {
        old.close();
      } catch {
        /* ignore */
      }
      setState('reconnecting');
      if (onClose) onClose();
    }
    nudge();
  }

  window.addEventListener('online', nudge);

  open();

  return {
    /** Returns true when the message was handed to an open socket. */
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    nudge,
    reset,
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      window.removeEventListener('online', nudge);
      const old = ws;
      ws = null;
      if (old) {
        try {
          old.close();
        } catch {
          /* ignore */
        }
      }
      setState('closed');
    },
    get state() {
      return state;
    },
    get isOpen() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    /** Bytes queued on the socket and not yet sent (0 when closed). */
    get bufferedAmount() {
      return ws && ws.readyState === WebSocket.OPEN ? ws.bufferedAmount : 0;
    },
    get attempts() {
      return attempt;
    },
  };
}
