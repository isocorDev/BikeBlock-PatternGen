// Persistence: autosave, named saves, and settings encoded in the URL.

import type { Settings } from './settings';

const AUTOSAVE = 'bikeblock.autosave';
const SAVED = 'bikeblock.saved';

export interface SavedDesign {
  id: string;
  name: string;
  savedAt: string;
  settings: Settings;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* storage unavailable (private mode); the app still works */
  }
}

export function loadAutosave(): unknown | null {
  const t = safeGet(AUTOSAVE);
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}
export function autosave(s: Settings) {
  safeSet(AUTOSAVE, JSON.stringify(s));
}

export function listSaved(): SavedDesign[] {
  try {
    const t = safeGet(SAVED);
    const arr = t ? JSON.parse(t) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
export function saveDesign(s: Settings): SavedDesign {
  const list = listSaved();
  const item: SavedDesign = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: `${s.name || 'Untitled'} No. ${s.edition}`,
    savedAt: new Date().toISOString(),
    settings: s,
  };
  list.unshift(item);
  safeSet(SAVED, JSON.stringify(list.slice(0, 200)));
  return item;
}
export function deleteSaved(id: string) {
  safeSet(SAVED, JSON.stringify(listSaved().filter((d) => d.id !== id)));
}

// URL hash: base64url of the settings JSON.
export function encodeHash(s: Settings): string {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeHash(h: string): unknown | null {
  try {
    const b64 = h.replace(/^#/, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!b64) return null;
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
