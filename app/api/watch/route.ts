import { watchManager } from '@/lib/watch-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const root = searchParams.get('root');

  if (!root) {
    return new Response('Missing root', { status: 400 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const unsubscribe = watchManager.subscribe(root, () => {
        send({ type: 'change', timestamp: Date.now() });
      });

      const heartbeat = setInterval(() => {
        send({ type: 'ping', timestamp: Date.now() });
      }, 15000);

      send({ type: 'ready', timestamp: Date.now() });

      return () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      // handled in start return
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  });
}
