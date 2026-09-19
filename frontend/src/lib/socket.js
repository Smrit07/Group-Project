import { io } from 'socket.io-client';
import { writable } from 'svelte/store';

// Same reasoning as api.js: default to the page's own origin so the app works
// unchanged from a phone on the campus network, where "localhost" would point
// at the phone itself. Apache proxies /socket.io through to Node.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;
const SOCKET_PATH = import.meta.env.BASE_URL + 'socket.io';

/**
 * Live connection state, so the UI can tell the user when updates have stopped
 * arriving. Silently showing stale queue numbers is worse than showing none:
 * the entire value of the banner is that it is current.
 */
export const socketConnected = writable(false);

let socket;

export function getSocket() {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    autoConnect: true,
    // Apache needs mod_proxy_wstunnel enabled for a true WebSocket. If it is
    // not, this falls back to long polling rather than failing outright —
    // slower live updates instead of none.
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    // Give up announcing after ~1 minute of failures rather than retrying
    // forever on a laptop that has been shut in a bag.
    reconnectionAttempts: 20,
    path: SOCKET_PATH,
  });

  socket.on('connect', () => socketConnected.set(true));
  socket.on('disconnect', () => socketConnected.set(false));
  socket.on('connect_error', () => socketConnected.set(false));

  return socket;
}

/**
 * Subscribe to several events at once and get a single unsubscribe function.
 * Every component that listened to the three order events had to remember to
 * remove all three in onDestroy; forgetting one leaks a handler on every
 * navigation, and the symptom (the page getting slower the longer it is open)
 * is very hard to trace back.
 */
export function subscribe(events, handler) {
  const active = getSocket();
  for (const event of events) active.on(event, handler);
  return () => {
    for (const event of events) active.off(event, handler);
  };
}
