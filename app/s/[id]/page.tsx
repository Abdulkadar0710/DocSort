import { Suspense } from 'react';
import { Workspace } from '@/components/Workspace';

/**
 * Server shell for the review workspace.
 *
 * Next.js 16 will not let a client hook block prerendering, so the route param
 * is resolved here rather than with useParams(). Reading `params` is itself
 * runtime data, which has to be either wrapped in Suspense or explicitly opted
 * out of prerendering — left unhandled it throws on every render, which in dev
 * remounts the client tree in a loop and sends it into continuous polling.
 *
 * A session workspace is dynamic by nature (it is one specific bundle mid
 * review), so there is nothing useful to prerender.
 */
export const instant = false;

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-2xl px-6 py-16">
          <p className="text-sm text-slate-500">Loading session…</p>
        </main>
      }
    >
      <Workspace sessionId={id} />
    </Suspense>
  );
}
