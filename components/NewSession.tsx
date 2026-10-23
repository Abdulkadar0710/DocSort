'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { browserClient } from '@/lib/supabase';
import { buildInventory, openPdf } from '@/lib/pdf/client';
import { deviceId } from '@/lib/device';

type Phase = 'idle' | 'uploading' | 'reading' | 'queueing' | 'error';

/**
 * Step 1 of the reviewer's four steps: start a session and upload the bundle.
 *
 * The file goes browser → Supabase Storage directly via a server-minted signed
 * URL, never through a Vercel function, which is what lets a bundle far larger
 * than the 4.5 MB request-body limit through. The page inventory is then read
 * locally with pdf.js and posted as compact JSON.
 */
export function NewSession() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [detail, setDetail] = useState('');
  const [pct, setPct] = useState(0);

  const busy = phase !== 'idle' && phase !== 'error';

  async function handleFile(file: File) {
    setPhase('uploading');
    setDetail(`Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`);
    setPct(0);

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceId(),
          name: file.name.replace(/\.pdf$/i, ''),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'could not start a session');
      const { session, upload } = await res.json();

      // Read the bytes once and reuse them for both the upload and the
      // inventory, so a large bundle is never held in memory twice.
      const bytes = await file.arrayBuffer();

      const sb = browserClient();
      const { error: upErr } = await sb.storage
        .from(upload.bucket)
        .uploadToSignedUrl(upload.path, upload.token, bytes, {
          contentType: 'application/pdf',
        });
      if (upErr) throw new Error(`upload failed: ${upErr.message}`);

      setPhase('reading');
      setDetail('Reading the bundle');
      const { doc, destroy } = await openPdf(bytes.slice(0));
      const pages = await buildInventory(doc, (done, total) => {
        setPct(Math.round((done / total) * 100));
        setDetail(`Reading page ${done} of ${total}`);
      });
      await destroy();

      setPhase('queueing');
      setDetail('Preparing the first proposal');
      const invRes = await fetch(`/api/sessions/${session.id}/inventory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pages }),
      });
      if (!invRes.ok) {
        throw new Error((await invRes.json()).error ?? 'could not store the inventory');
      }

      router.push(`/s/${session.id}`);
    } catch (e) {
      setPhase('error');
      setDetail(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 dark:border-slate-700 dark:bg-slate-900">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />

      <div className="text-center">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Start a new session
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-600 dark:text-slate-400">
          Upload one bundle PDF. Nothing is split until you review the proposed
          documents and approve them.
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="mt-5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        >
          {busy ? 'Working…' : 'Choose bundle PDF'}
        </button>

        {phase !== 'idle' && (
          <div className="mt-5">
            <p
              className={`text-sm ${
                phase === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {phase === 'error' ? `Could not continue — ${detail}` : detail}
            </p>
            {phase === 'reading' && (
              <div className="mx-auto mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-slate-900 transition-all dark:bg-slate-100"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
