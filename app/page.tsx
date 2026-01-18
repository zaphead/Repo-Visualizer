'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  ReactFlowInstance,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState
} from 'reactflow';
import dagre from 'dagre';
import { toPng } from 'html-to-image';
import 'reactflow/dist/style.css';

import type { GraphData, GraphEdge, GraphNode } from '@/lib/types';
import { scanDirectoryHandle } from '@/lib/browser-scan';

const layoutGraph = (nodes: GraphNode[], edges: GraphEdge[]) => {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 60 });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: 180, height: 44 });
  });

  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  return nodes.map((node) => {
    const layoutNode = g.node(node.id) || { x: 0, y: 0 };
    return {
      ...node,
      position: { x: layoutNode.x, y: layoutNode.y }
    };
  });
};

const buildAdjacency = (edges: GraphEdge[]) => {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  edges.forEach((edge) => {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Set());
    if (!incoming.has(edge.target)) incoming.set(edge.target, new Set());
    outgoing.get(edge.source)?.add(edge.target);
    incoming.get(edge.target)?.add(edge.source);
  });

  return { outgoing, incoming };
};

const filterFocus = (
  nodes: GraphNode[],
  edges: GraphEdge[],
  focusId: string | null,
  depth: number
) => {
  if (!focusId || depth <= 0) return { nodes, edges };
  const { outgoing, incoming } = buildAdjacency(edges);
  const allowed = new Set<string>([focusId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: focusId, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth >= depth) continue;

    const neighbors = new Set<string>([
      ...(outgoing.get(current.id) ?? []),
      ...(incoming.get(current.id) ?? [])
    ]);

    neighbors.forEach((neighbor) => {
      if (!allowed.has(neighbor)) {
        allowed.add(neighbor);
        queue.push({ id: neighbor, depth: current.depth + 1 });
      }
    });
  }

  const filteredNodes = nodes.filter((node) => allowed.has(node.id));
  const filteredEdges = edges.filter(
    (edge) => allowed.has(edge.source) && allowed.has(edge.target)
  );

  return { nodes: filteredNodes, edges: filteredEdges };
};

export default function Home() {
  const [pathInput, setPathInput] = useState('');
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [layouting, setLayouting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useRepoRoot, setUseRepoRoot] = useState(true);
  const [maxFiles, setMaxFiles] = useState(5000);
  const [showIgnored, setShowIgnored] = useState(false);
  const [showExternal, setShowExternal] = useState(false);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [watchEnabled, setWatchEnabled] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [focusDepth, setFocusDepth] = useState(2);
  const [search, setSearch] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<'file' | 'symbol'>('file');
  const [scanMode, setScanMode] = useState<'server' | 'browser'>('server');
  const [selectedHandle, setSelectedHandle] = useState<FileSystemDirectoryHandle | null>(
    null
  );
  const trimmedPath = pathInput.trim();

  const graphWrapperRef = useRef<HTMLDivElement>(null);
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const lastRootRef = useRef<string | null>(null);
  const watchSourceRef = useRef<EventSource | null>(null);
  const watchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextScanRef = useRef(false);

  const fetchGraph = useCallback(
    async (root: string) => {
      setLoading(true);
      setError(null);
      setSelectedEdgeId(null);
      try {
        const response = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            root,
            maxFiles,
            includeExternal: showExternal,
            granularity
          })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Scan failed.');
        }
        setGraphData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Scan failed.');
      } finally {
        setLoading(false);
      }
    },
    [maxFiles, showExternal, granularity]
  );

  const scanBrowser = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      setLoading(true);
      setError(null);
      setSelectedEdgeId(null);
      try {
        const data = await scanDirectoryHandle({
          rootHandle: handle,
          maxFiles,
          includeExternal: showExternal
        });
        setGraphData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Scan failed.');
      } finally {
        setLoading(false);
      }
    },
    [maxFiles, showExternal]
  );

  const detectRootAndScan = useCallback(async () => {
    if (!trimmedPath) {
      setError('Enter an absolute folder path to scan.');
      return;
    }
    setScanMode('server');
    setSelectedHandle(null);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/detect-root', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmedPath })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to detect repo root.');
      }

      const finalRoot = useRepoRoot && data.repoRoot ? data.repoRoot : trimmedPath;
      if (finalRoot === selectedRoot) {
        await fetchGraph(finalRoot);
      } else {
        setSelectedRoot(finalRoot);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to select folder.');
      setLoading(false);
    }
  }, [trimmedPath, useRepoRoot, selectedRoot, fetchGraph]);

  const pickFolderAndScan = useCallback(async () => {
    setError(null);
    if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
      setError('Folder picker not supported in this browser. Use the manual path.');
      return;
    }
    try {
      const handle = await (
        window as Window & { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker();
      setScanMode('browser');
      setSelectedHandle(handle);
      setSelectedRoot(handle.name);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unable to open folder picker.');
    }
  }, []);

  useEffect(() => {
    if (scanMode !== 'server' || !selectedRoot || !watchEnabled) {
      watchSourceRef.current?.close();
      watchSourceRef.current = null;
      return;
    }

    const source = new EventSource(`/api/watch?root=${encodeURIComponent(selectedRoot)}`);
    watchSourceRef.current = source;

    source.onmessage = () => {
      if (watchTimerRef.current) return;
      watchTimerRef.current = setTimeout(() => {
        watchTimerRef.current = null;
        fetchGraph(selectedRoot);
      }, 500);
    };

    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, [selectedRoot, watchEnabled, fetchGraph, scanMode]);

  useEffect(() => {
    if (!selectedRoot || scanMode !== 'server') return;
    if (skipNextScanRef.current) {
      skipNextScanRef.current = false;
      return;
    }
    fetchGraph(selectedRoot);
  }, [selectedRoot, showExternal, maxFiles, fetchGraph, scanMode]);

  useEffect(() => {
    if (scanMode !== 'browser' || !selectedHandle) return;
    scanBrowser(selectedHandle);
  }, [scanMode, selectedHandle, scanBrowser, showExternal, maxFiles]);

  useEffect(() => {
    if (!graphData || !reactFlowInstanceRef.current) return;
    if (graphData.root !== lastRootRef.current) {
      lastRootRef.current = graphData.root;
      requestAnimationFrame(() => {
        reactFlowInstanceRef.current?.fitView({ padding: 0.2 });
      });
    }
  }, [graphData]);

  const filteredGraph = useMemo(() => {
    if (!graphData) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };

    let nodes = graphData.nodes.filter((node) => (showIgnored ? true : !node.ignored));
    nodes = nodes.filter((node) => (showExternal ? true : node.type !== 'external'));

    let edges = graphData.edges.filter((edge) =>
      showExternal ? true : edge.type !== 'external'
    );

    const nodeIds = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

    if (focusMode && selectedNodeId) {
      const focused = filterFocus(nodes, edges, selectedNodeId, focusDepth);
      return focused;
    }

    return { nodes, edges };
  }, [graphData, showIgnored, showExternal, focusMode, selectedNodeId, focusDepth]);

  const layoutedNodes = useMemo(() => {
    if (!filteredGraph.nodes.length) return [];
    return layoutGraph(filteredGraph.nodes, filteredGraph.edges);
  }, [filteredGraph.nodes, filteredGraph.edges]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (!filteredGraph.nodes.length) {
      setRfNodes([]);
      return;
    }
    setLayouting(true);
    const nextNodes = layoutedNodes.map((node) => ({
      id: node.id,
      data: { label: node.label, path: node.path },
      position: node.position,
      className: [node.type, node.ignored ? 'ignored' : '']
        .filter(Boolean)
        .join(' ')
    }));
    setRfNodes(nextNodes);
    const frame = requestAnimationFrame(() => setLayouting(false));
    return () => cancelAnimationFrame(frame);
  }, [layoutedNodes, filteredGraph.nodes, setRfNodes]);

  useEffect(() => {
    const nextEdges = filteredGraph.edges.map((edge) => {
      const colorMap: Record<string, string> = {
        static: 'var(--edge-static)',
        dynamic: 'var(--edge-dynamic)',
        style: 'var(--edge-style)',
        external: 'var(--edge-external)'
      };
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: colorMap[edge.type] ?? 'var(--edge-static)'
        },
        className: `edge-${edge.type}`
      };
    });
    setRfEdges(nextEdges);
  }, [filteredGraph.edges, setRfEdges]);

  const adjacency = useMemo(() => buildAdjacency(filteredGraph.edges), [filteredGraph.edges]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !graphData) return null;
    return graphData.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [selectedNodeId, graphData]);

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId || !graphData) return null;
    return graphData.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  }, [selectedEdgeId, graphData]);

  const searchResults = useMemo(() => {
    if (search.trim().length < 2) return [];
    const term = search.toLowerCase();
    return filteredGraph.nodes
      .filter((node) => node.path.toLowerCase().includes(term))
      .slice(0, 12);
  }, [filteredGraph.nodes, search]);

  const centerOnNode = (nodeId: string) => {
    const node = layoutedNodes.find((item) => item.id === nodeId);
    if (!node || !reactFlowInstanceRef.current) return;
    reactFlowInstanceRef.current.setCenter(node.position.x, node.position.y, {
      zoom: 1.2,
      duration: 300
    });
    setSelectedNodeId(nodeId);
  };

  const exportPng = async () => {
    if (!graphWrapperRef.current || !reactFlowInstanceRef.current) return;
    const viewport = graphWrapperRef.current.querySelector(
      '.react-flow__viewport'
    ) as HTMLElement | null;
    if (!viewport) return;

    const nodesBounds = getNodesBounds(reactFlowInstanceRef.current.getNodes());
    const { width, height } = graphWrapperRef.current.getBoundingClientRect();
    const viewportTransform = getViewportForBounds(nodesBounds, width, height, 0.2, 2);

    const dataUrl = await toPng(viewport, {
      backgroundColor: '#0b0f14',
      width,
      height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${viewportTransform.x}px, ${viewportTransform.y}px) scale(${viewportTransform.zoom})`
      }
    });

    const link = document.createElement('a');
    link.download = `graph-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  };

  const exportJson = () => {
    if (!graphData) return;
    const payload = {
      root: graphData.root,
      nodes: filteredGraph.nodes,
      edges: filteredGraph.edges,
      totalFiles: graphData.totalFiles,
      ignoredCount: graphData.ignoredCount,
      externalCount: graphData.externalCount
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `graph-${Date.now()}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        setGraphData(parsed);
        skipNextScanRef.current = true;
        setSelectedRoot(parsed.root || selectedRoot);
      } catch (err) {
        setError('Invalid graph JSON.');
      }
    };
    reader.readAsText(file);
  };

  const incomingList = selectedNode
    ? Array.from(adjacency.incoming.get(selectedNode.id) ?? [])
    : [];
  const outgoingList = selectedNode
    ? Array.from(adjacency.outgoing.get(selectedNode.id) ?? [])
    : [];

  return (
    <div className="main">
      <div className="toolbar">
        <section>
          <label>Repository</label>
          <div className="toolbar-row">
            <input
              className="input"
              placeholder="/absolute/path/to/repo"
              value={pathInput}
              onChange={(event) => {
                setPathInput(event.target.value);
                if (error) setError(null);
              }}
            />
            <button className="button primary" onClick={pickFolderAndScan} disabled={loading}>
              Select folder
            </button>
            <button
              className="button"
              onClick={detectRootAndScan}
              disabled={!trimmedPath || loading}
            >
              Scan path
            </button>
            <button
              className="button"
              onClick={() => {
                if (scanMode === 'browser' && selectedHandle) {
                  scanBrowser(selectedHandle);
                }
                if (scanMode === 'server' && selectedRoot) {
                  fetchGraph(selectedRoot);
                }
              }}
              disabled={
                loading ||
                (scanMode === 'browser' ? !selectedHandle : !selectedRoot)
              }
            >
              Rebuild graph
            </button>
          </div>
          <div className="toolbar-row">
            <label className="badge">
              <input
                type="checkbox"
                checked={useRepoRoot}
                onChange={(event) => setUseRepoRoot(event.target.checked)}
                disabled={scanMode === 'browser'}
              />
              Prefer repo root
            </label>
            <span className="badge">
              Current: {selectedRoot ?? 'None'} ·{' '}
              {scanMode === 'browser' ? 'Browser' : 'Path'}
            </span>
          </div>
        </section>

        <section>
          <label>Settings</label>
          <div className="toolbar-row">
            <label className="badge">
              Max files
              <input
                className="input"
                type="number"
                min={100}
                value={maxFiles}
                onChange={(event) => setMaxFiles(Number(event.target.value))}
              />
            </label>
            <label className="badge">
              <input
                type="checkbox"
                checked={showIgnored}
                onChange={(event) => setShowIgnored(event.target.checked)}
              />
              Show ignored
            </label>
            <label className="badge">
              <input
                type="checkbox"
                checked={showExternal}
                onChange={(event) => setShowExternal(event.target.checked)}
              />
              Show externals
            </label>
          </div>
          <div className="toolbar-row">
            <label className="badge">
              <input
                type="checkbox"
                checked={watchEnabled}
                onChange={(event) => setWatchEnabled(event.target.checked)}
                disabled={scanMode === 'browser'}
              />
              Watch changes
            </label>
            <label className="badge">
              <input
                type="checkbox"
                checked={showMiniMap}
                onChange={(event) => setShowMiniMap(event.target.checked)}
              />
              Mini-map
            </label>
            <label className="badge">
              <input
                type="checkbox"
                checked={focusMode}
                onChange={(event) => setFocusMode(event.target.checked)}
              />
              Focus mode
            </label>
            {focusMode && (
              <label className="badge">
                Depth
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={focusDepth}
                  onChange={(event) => setFocusDepth(Number(event.target.value))}
                />
              </label>
            )}
          </div>
        </section>

        <section>
          <label>Actions</label>
          <div className="toolbar-row">
            <button className="button" onClick={exportPng} disabled={!graphData}>
              Export PNG
            </button>
            <button className="button" onClick={exportJson} disabled={!graphData}>
              Export JSON
            </button>
            <label className="button">
              Import JSON
              <input type="file" accept="application/json" hidden onChange={importJson} />
            </label>
          </div>
          <div className="toolbar-row">
            <input
              className="input"
              placeholder="Search by path"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {searchResults.length > 0 && (
            <div className="list">
              {searchResults.map((result) => (
                <button key={result.id} onClick={() => centerOnNode(result.id)}>
                  {result.path}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="graph-shell" ref={graphWrapperRef}>
        {loading && <div className="loading">Scanning…</div>}
        {layouting && <div className="loading">Layouting…</div>}
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onInit={(instance) => {
            reactFlowInstanceRef.current = instance;
            instance.fitView({ padding: 0.2 });
          }}
          onNodeClick={(_, node) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedNodeId(null);
          }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          panOnDrag
          zoomOnScroll
        >
          <Background gap={16} size={0.5} color="#1b2a3d" />
          <Controls showInteractive={false} />
          {showMiniMap && <MiniMap pannable zoomable />}
        </ReactFlow>
      </div>

      <aside className="panel">
        <h2>Details</h2>
        {error && <div className="notice error">{error}</div>}
        {!selectedNode && !selectedEdge && (
          <small>Select a node or edge to inspect relationships.</small>
        )}

        {selectedNode && (
          <div className="kv">
            <div>
              <span>Path</span>
              <div>{selectedNode.path}</div>
            </div>
            <div>
              <span>Type</span>
              <div>{selectedNode.type}</div>
            </div>
            <div>
              <span>Incoming</span>
              <div>{incomingList.length}</div>
            </div>
            <div>
              <span>Outgoing</span>
              <div>{outgoingList.length}</div>
            </div>
            <div>
              <span>Imports</span>
              <div className="list">
                {outgoingList.length === 0 && <small>None</small>}
                {outgoingList.map((item) => (
                  <button key={item} onClick={() => centerOnNode(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span>Importers</span>
              <div className="list">
                {incomingList.length === 0 && <small>None</small>}
                {incomingList.map((item) => (
                  <button key={item} onClick={() => centerOnNode(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {selectedEdge && (
          <div className="kv">
            <div>
              <span>Edge</span>
              <div>
                {selectedEdge.source} → {selectedEdge.target}
              </div>
            </div>
            <div>
              <span>Type</span>
              <div>{selectedEdge.type}</div>
            </div>
            {selectedEdge.loc && (
              <div>
                <span>Location</span>
                <div>
                  Line {selectedEdge.loc.line}, column {selectedEdge.loc.column}
                </div>
              </div>
            )}
            {selectedEdge.statement && (
              <div>
                <span>Statement</span>
                <pre className="input" style={{ whiteSpace: 'pre-wrap' }}>
                  {selectedEdge.statement}
                </pre>
              </div>
            )}
          </div>
        )}

        <div className="legend">
          <strong>Legend</strong>
          <span>
            <i style={{ background: 'var(--node-route)' }} /> Route node
          </span>
          <span>
            <i style={{ background: 'var(--node-module)' }} /> Module node
          </span>
          <span>
            <i style={{ background: 'var(--node-style)' }} /> Style node
          </span>
          <span>
            <i style={{ background: 'var(--node-external)' }} /> External
          </span>
          <span>
            <i style={{ background: 'var(--edge-static)' }} /> Static import
          </span>
          <span>
            <i style={{ background: 'var(--edge-dynamic)' }} /> Dynamic import
          </span>
          <span>
            <i style={{ background: 'var(--edge-style)' }} /> Style import
          </span>
        </div>

        {graphData && (
          <div className="notice">
            {graphData.totalFiles} files scanned · {graphData.ignoredCount} ignored ·{' '}
            {graphData.externalCount} external references
          </div>
        )}
      </aside>
    </div>
  );
}
