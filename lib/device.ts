'use client';

/**
 * Login is out of scope per the brief, but sessions must still persist and be
 * reopenable. A per-browser id gives each reviewer their own session list
 * without any auth. It is a convenience, not a security boundary.
 */
const KEY = 'unbundle.device_id';

export function deviceId(): string {
  if (typeof window === 'undefined') return '';
  let id = window.localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(KEY, id);
  }
  return id;
}
