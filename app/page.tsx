'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { NewSession } from '@/components/NewSession';
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

const STATUS_LABEL: Record<string, string> = {
  uploading: 'Uploading',
  inventorying: 'Reading bundle',
  processing: 'Identifying documents',
  proposed: 'Awaiting review',
  approved: 'Approved',
  failed: 'Failed',
};

const STATUS_STYLE: Record<string, string> = {
  approved:
    'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  proposed:
    'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

export default function Home() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const id = deviceId();
    if (!id) return;
    fetch(`/api/sessions?device=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setSessions(d.sessions)))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Unbundle
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Turn one medico-legal bundle into individual, identified documents —
          with every page traceable back to where it came from.
        </p>
      </header>

      <NewSession />

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          Past sessions
        </h2>

        {error && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {sessions === null && !error && (
          <p className="text-sm text-slate-500">Loading…</p>
        )}

        {sessions?.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No sessions yet. Upload a bundle to begin.
          </p>
        )}

        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {sessions?.map((s) => (
            <li key={s.id}>
              <Link
                href={`/s/${s.id}`}
                className="flex items-center justify-between gap-4 py-3 transition hover:opacity-70"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {s.name}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {new Date(s.created_at).toLocaleString()}
                    {s.page_count ? ` · ${s.page_count} pages` : ''}
                    {s.doc_count ? ` · ${s.doc_count} documents` : ''}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    STATUS_STYLE[s.status] ??
                    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                  }`}
                >
                  {STATUS_LABEL[s.status] ?? s.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
