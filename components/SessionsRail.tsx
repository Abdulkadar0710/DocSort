'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { deviceId } from '@/lib/device';

interface SessionRow {
  id: string;
  name: string;
  status: string;
  page_count: number | null;
  doc_count: number | null;
  approved_at: string | null;
  created_at: string;
}

/**
 * The sessions rail.
 *
 * Present inside the workspace rather than only on a separate index, because
 * the brief treats reopening past work as part of the job: every upload is its
 * own session, saved with its feedback history, and a reviewer moves between
 * them. Keeping the list to hand makes that a click rather than a navigation.
 */
export function SessionsRail({ currentId }: { currentId: string }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);

  useEffect(() => {
    const id = deviceId();
    if (!id) return;
    let cancelled = false;
    fetch(`/api/sessions?device=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setSessions(d.sessions ?? []))
      .catch(() => !cancelled && setSessions([]));
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
      <div className="px-3 py-3">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Sessions
        </h2>
        <Link
          href="/"
          className="block rounded-md border border-blue-300 bg-white px-3 py-1.5 text-center text-xs font-medium text-blue-700 transition hover:bg-blue-50 dark:border-blue-800 dark:bg-slate-900 dark:text-blue-300 dark:hover:bg-slate-800"
        >
          + New session
        </Link>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sessions === null && (
          <li className="px-1 py-2 text-[11px] text-slate-400">Loading…</li>
        )}

        {sessions?.map((s) => {
          const current = s.id === currentId;
          return (
            <li key={s.id}>
              <Link
                href={`/s/${s.id}`}
                className={`block rounded-md px-2 py-2 transition ${
                  current
                    ? 'bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700'
                    : 'hover:bg-white/70 dark:hover:bg-slate-900/60'
                }`}
              >
                <p className="truncate text-xs font-medium text-slate-900 dark:text-slate-100">
                  {s.name}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-slate-500 dark:text-slate-400">
                  {new Date(s.created_at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                  })}
                  {' · '}
                  {s.status === 'approved' ? 'approved' : 'awaiting approval'}
                </p>
              </Link>
            </li>
          );
        })}

        {sessions?.length === 0 && (
          <li className="px-1 py-2 text-[11px] text-slate-400">No sessions yet.</li>
        )}
      </ul>
    </aside>
  );
}
