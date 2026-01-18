import chokidar, { FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';

const ALWAYS_IGNORE = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.DS_Store'
];

type WatchEntry = {
  watcher: FSWatcher;
  emitter: EventEmitter;
  refCount: number;
};

class WatchManager {
  private watchers = new Map<string, WatchEntry>();

  subscribe(root: string, onChange: () => void) {
    const entry = this.ensureWatcher(root);
    entry.refCount += 1;
    entry.emitter.on('change', onChange);

    return () => {
      entry.refCount -= 1;
      entry.emitter.off('change', onChange);
      if (entry.refCount <= 0) {
        entry.watcher.close();
        this.watchers.delete(root);
      }
    };
  }

  private ensureWatcher(root: string) {
    let entry = this.watchers.get(root);
    if (entry) return entry;

    const emitter = new EventEmitter();
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: ALWAYS_IGNORE,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });

    const notify = () => emitter.emit('change');
    watcher
      .on('add', notify)
      .on('change', notify)
      .on('unlink', notify)
      .on('addDir', notify)
      .on('unlinkDir', notify);

    entry = { watcher, emitter, refCount: 0 };
    this.watchers.set(root, entry);
    return entry;
  }
}

export const watchManager = new WatchManager();
