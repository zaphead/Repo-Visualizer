export type NodeType = 'route' | 'module' | 'style' | 'external' | 'symbol';
export type EdgeType = 'static' | 'dynamic' | 'style' | 'external' | 'contains';

export type GraphNode = {
  id: string;
  path: string;
  label: string;
  type: NodeType;
  ignored?: boolean;
  symbolKind?: string;
  parent?: string;
  displayName?: string;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  statement?: string;
  loc?: {
    line: number;
    column: number;
  };
};

export type GraphData = {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalFiles: number;
  ignoredCount: number;
  externalCount: number;
};
