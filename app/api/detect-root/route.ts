import { NextResponse } from 'next/server';
import { detectRepoRoot } from '@/lib/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const inputPath = String(body.path || '').trim();

    if (!inputPath) {
      return NextResponse.json({ error: 'Missing path.' }, { status: 400 });
    }

    const repoRoot = await detectRepoRoot(inputPath);
    return NextResponse.json({ repoRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Root detection failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
