# Repo Visualizer

Local-first Next.js app that scans a folder on your machine and renders an interactive dependency graph.

## Setup

```bash
npm install
```

## Run (dev)

```bash
npm run dev
```

Open `http://localhost:3000`.

## Build + start (production)

```bash
npm run build
npm run start
```

## Notes

- Use an absolute folder path when selecting a repo.
- "Prefer repo root" will move to the closest parent directory containing `.git`.
- Max files is a safety limit; increase it if the scan stops early.
- All scanning happens locally. No code or metadata leaves your machine.
- Watch changes uses local filesystem events; use Rebuild if you need a manual refresh.
