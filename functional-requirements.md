Build a local-first web app (Next.js) that generates an interactive dependency graph for a selected codebase folder on my computer.

Functional requirements:

1. App basics

* Runs locally on my machine (dev + production build).
* Home screen has a “Select folder” action and shows the currently selected root path.
* The app never uploads code or metadata anywhere; everything stays local.

2. Folder/repo selection

* I can select a folder on my computer that contains a repo/project.
* The app detects the repo root (if there’s a .git folder) and treats that as the root unless I explicitly choose a different folder.
* I can switch to a different folder at any time and rebuild the graph.

3. Ignore rules

* Respect .gitignore rules from the selected repo (including negations and nested .gitignore files).
* Always ignore: node_modules, .next, dist, build, out, coverage, .turbo, .cache, .DS_Store (even if not in .gitignore).
* Do not read binary files (images, videos, archives); only code/text files relevant to JS/TS/CSS.
* Provide a small UI panel that shows “Ignored by rules” counts and lets me toggle “show ignored files” (off by default).

4. What to graph

* Primary goal: visualize import/dependency relationships within the folder.
* Nodes represent files by default.
* Edges represent static dependencies:
  * ES imports/exports (import, export from)
  * CommonJS requires (require())
  * Dynamic imports (import()) should be included and visually distinguished from static imports.
  * CSS imports should be included (including CSS Modules).
* Next.js specifics:
  * Recognize and include app/ and pages/ routing entrypoints as special node types.
  * Highlight route nodes differently from regular modules.
  * Treat Next.js alias paths (like “@/…”) as resolvable to real files within the project.
* Exclude dependencies that resolve outside the selected root (e.g., node_modules). Those should either be omitted or optionally represented as a collapsed “external” node (toggleable).

5. Graph interaction (canvas)

* The graph renders on a zoomable/pannable canvas.
* I can click and drag nodes to reposition them.
* Zoom in/out with mouse wheel/trackpad; pan by dragging the background.
* A mini-map overview in a corner (toggleable).
* Search box to find a node by filename/path; selecting centers the view on it.
* Clicking a node shows a side panel with:
  * full relative path
  * node type (route/module/style/etc.)
  * number of incoming edges and outgoing edges
  * list of direct imports and direct importers (clicking items navigates to those nodes)
* Clicking an edge can show the import statement / source location if available.
* Ability to “focus” on a node: temporarily show only N hops from it (configurable depth slider).
* Ability to collapse/expand folders as groups (optional, but if implemented it must be reliable).

6. Live / incremental updates

* When the selected folder changes (file added/removed/edited), the graph updates automatically (watch mode).
* Updates should feel live: no full page refresh.
* Provide a “Rebuild graph” button for manual full rebuild.

7. Performance & scale behavior

* Must handle repos with thousands of files without freezing the UI.
* Show a progress indicator during initial scan/build and on large updates.
* Provide a “max files” safety limit setting with a warning if exceeded (default on, user-adjustable).
* Layout should converge reasonably; if layout is still computing, the user can still pan/zoom/select nodes.

8. Output / sharing

* Export current graph view as an image (PNG) and as a JSON representation of nodes/edges.
* Import a previously exported JSON to restore a graph without rescanning the repo.

9. UX polish

* Dark mode UI by default.
* Basic legend explaining node colors/types and edge types (static vs dynamic vs style).
* Error handling for unreadable folders, permission issues, and malformed files.

Deliverables

* A working Next.js app that I can run locally.
* Clear run instructions (install, dev, build, start).
* All features above implemented; no extra scope unless it directly improves usability.
