import { Suspense } from 'react';
import { DownloadsPage } from '@/components/DownloadsPage';

/**
 * The approved outputs, as the step after review. Same server-shell pattern
 * as the workspace route: the param is runtime data, so it is resolved here
 * inside Suspense and nothing is prerendered.
 */
export const instant = false;

export default async function SessionDownloadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-2xl px-6 py-16">
          <p className="text-sm text-slate-500">Loading downloads…</p>
        </main>
      }
    >
      <DownloadsPage sessionId={id} />
    </Suspense>
  );
}
