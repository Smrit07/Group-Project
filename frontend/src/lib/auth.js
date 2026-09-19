import { writable } from 'svelte/store';

const STORAGE_KEY = 'smart_cafeteria_session';

function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const session = writable(loadInitial()); // { token, user: { id, fullName, email, role } }

session.subscribe((value) => {
  if (value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
});

export function logout() {
  session.set(null);
}
