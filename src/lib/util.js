// src/lib/util.js
// Theme, small storage helpers and date formatting.

const THEME_KEY = 'cc_theme';
const media = window.matchMedia?.('(prefers-color-scheme: dark)');

export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

export function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* storage blocked */ }
  paintTheme();
}

export function paintTheme() {
  const pref = getTheme();
  const dark = pref === 'dark' || (pref === 'system' && media?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
media?.addEventListener?.('change', () => { if (getTheme() === 'system') paintTheme(); });

export const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
export const recall = (key, fallback = '') => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const n = (v) => Number(v || 0).toLocaleString();
export const plural = (count, one, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

export function fmtWhen(value) {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    hour: 'numeric', minute: '2-digit',
  });
}

export function fmtSpan(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} day${d === 1 ? '' : 's'} ${h % 24} h` : `${d} day${d === 1 ? '' : 's'}`;
}

// Just the day, e.g. "Oct 2" ("Oct 2, 2025" in another year).
export function fmtDay(value) {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

export const fmtInterval = (minutes) =>
  minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const TIMEZONES = [
  ['America/New_York', 'Eastern (New York)'],
  ['America/Chicago', 'Central (Chicago)'],
  ['America/Denver', 'Mountain (Denver)'],
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
  ['America/Toronto', 'Toronto'],
  ['America/Vancouver', 'Vancouver'],
  ['UTC', 'UTC'],
  ['Asia/Manila', 'Philippines (Manila)'],
];
