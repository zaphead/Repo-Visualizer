import { NextResponse } from 'next/server';
import { scanProject } from '@/lib/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const root = String(body.root || '').trim();
    const maxFiles = Number(body.maxFiles || 5000);
    const includeExternal = Boolean(body.includeExternal);
    const granularity =
      body.granularity === 'symbol' || body.granularity === 'file'
        ? body.granularity
        : 'file';

    if (!root) {
      return NextResponse.json({ error: 'Missing root path.' }, { status: 400 });
    }

    const graph = await scanProject({ root, maxFiles, includeExternal, granularity });
    return NextResponse.json(graph);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scan failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
