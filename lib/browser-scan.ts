import ignore from 'ignore';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type { File } from '@babel/types';
import type { EdgeType, GraphData, GraphEdge, GraphNode } from './types';

const ALWAYS_IGNORE = [
  '.git/',
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.turbo/',
  '.cache/',
  '.DS_Store'
];

const SCRIPT_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs'
]);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass']);
const SUPPORTED_EXTENSIONS = new Set([
  ...SCRIPT_EXTENSIONS,
  ...STYLE_EXTENSIONS
]);

const IMPORT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass'
];

const ROUTE_REGEX = {
  app: /(^|\/)app\/(.*\/)?(page|route)\.(t|j)sx?$/,
  pages: /(^|\/)pages\/.+\.(t|j)sx?$/
};

type Dependency = {
  specifier: string;
  type: EdgeType;
  statement?: string;
  loc?: { line: number; column: number };
  imports?: ImportBinding[];
};

type BrowserScanOptions = {
  rootHandle: FileSystemDirectoryHandle;
  maxFiles: number;
  includeExternal: boolean;
  granularity?: ScanGranularity;
};

type ScanGranularity = 'file' | 'symbol';

type ImportBinding = {
  kind: 'default' | 'named' | 'namespace';
  imported: string;
  local: string;
};

type SymbolInfo = {
  name: string;
  kind: string;
  displayName?: string;
};

const posixJoin = (...parts: string[]) =>
  parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');

const posixDirname = (value: string) => {
  const idx = value.lastIndexOf('/');
  return idx === -1 ? '' : value.slice(0, idx);
};

const posixBasename = (value: string) => {
  const idx = value.lastIndexOf('/');
  return idx === -1 ? value : value.slice(idx + 1);
};

const posixExtname = (value: string) => {
  const base = posixBasename(value);
  const idx = base.lastIndexOf('.');
  return idx === -1 ? '' : base.slice(idx);
};

const normalizePosixPath = (value: string) => {
  const parts = value.split('/');
  const stack: string[] = [];
  let escapedRoot = false;

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length) {
        stack.pop();
      } else {
        escapedRoot = true;
      }
      continue;
    }
    stack.push(part);
  }

  return { path: stack.join('/'), escapedRoot };
};

const normalizeGitignorePattern = (dirRel: string, rawPattern: string) => {
  let pattern = rawPattern.trim();
  if (!pattern || pattern.startsWith('#')) return null;
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  if (!pattern) return null;

  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);

  const hasSlash = pattern.includes('/');
  const endsWithSlash = pattern.endsWith('/');

  const base = dirRel ? dirRel : '';

  let prefixed = pattern;

  if (base) {
    if (anchored || hasSlash) {
      prefixed = posixJoin(base, pattern);
    } else {
      prefixed = posixJoin(base, '**', pattern);
    }
  } else if (!anchored && !hasSlash) {
    prefixed = posixJoin('**', pattern);
  }

  if (endsWithSlash && !prefixed.endsWith('/')) {
    prefixed += '/';
  }

  return negated ? `!${prefixed}` : prefixed;
};

const nodeTypeFromPath = (relPath: string) => {
  if (relPath === '__external__') return 'external';
  if (ROUTE_REGEX.app.test(relPath) || ROUTE_REGEX.pages.test(relPath)) {
    if (relPath.includes('/pages/') || relPath.startsWith('pages/')) {
      const basename = posixBasename(relPath);
      if (basename.startsWith('_')) return 'module';
    }
    return 'route';
  }
  if (STYLE_EXTENSIONS.has(posixExtname(relPath))) return 'style';
  return 'module';
};

const extractDependencies = (filePath: string, code: string): Dependency[] => {
  const dependencies: Dependency[] = [];

  if (SCRIPT_EXTENSIONS.has(posixExtname(filePath))) {
    let ast: File | null = null;
    try {
      ast = parse(code, {
        sourceType: 'unambiguous',
        plugins: [
          'jsx',
          'typescript',
          'dynamicImport',
          'decorators-legacy',
          'classProperties',
          'classPrivateProperties',
          'importAssertions',
          'topLevelAwait'
        ]
      });
    } catch {
      return dependencies;
    }

    traverse(ast, {
      ImportDeclaration(pathNode) {
        const value = pathNode.node.source.value;
        const imports: ImportBinding[] = [];
        pathNode.node.specifiers.forEach((specifier) => {
          if (specifier.type === 'ImportDefaultSpecifier') {
            imports.push({
              kind: 'default',
              imported: 'default',
              local: specifier.local.name
            });
          } else if (specifier.type === 'ImportSpecifier') {
            const importedName =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value;
            imports.push({
              kind: 'named',
              imported: importedName,
              local: specifier.local.name
            });
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            imports.push({
              kind: 'namespace',
              imported: '*',
              local: specifier.local.name
            });
          }
        });
        dependencies.push({
          specifier: value,
          type: 'static',
          statement: code.slice(pathNode.node.start ?? 0, pathNode.node.end ?? 0),
          loc: pathNode.node.loc
            ? { line: pathNode.node.loc.start.line, column: pathNode.node.loc.start.column }
            : undefined,
          imports: imports.length ? imports : undefined
        });
      },
      ExportAllDeclaration(pathNode) {
        if (!pathNode.node.source) return;
        const value = pathNode.node.source.value;
        dependencies.push({
          specifier: value,
          type: 'static',
          statement: code.slice(pathNode.node.start ?? 0, pathNode.node.end ?? 0),
          loc: pathNode.node.loc
            ? { line: pathNode.node.loc.start.line, column: pathNode.node.loc.start.column }
            : undefined
        });
      },
      ExportNamedDeclaration(pathNode) {
        if (!pathNode.node.source) return;
        const value = pathNode.node.source.value;
        dependencies.push({
          specifier: value,
          type: 'static',
          statement: code.slice(pathNode.node.start ?? 0, pathNode.node.end ?? 0),
          loc: pathNode.node.loc
            ? { line: pathNode.node.loc.start.line, column: pathNode.node.loc.start.column }
            : undefined
        });
      },
      CallExpression(pathNode) {
        const callee = pathNode.node.callee;
        if (callee.type === 'Import') {
          const arg = pathNode.node.arguments[0];
          if (arg && arg.type === 'StringLiteral') {
            dependencies.push({
              specifier: arg.value,
              type: 'dynamic',
              statement: code.slice(pathNode.node.start ?? 0, pathNode.node.end ?? 0),
              loc: pathNode.node.loc
                ? { line: pathNode.node.loc.start.line, column: pathNode.node.loc.start.column }
                : undefined
            });
          }
        }

        if (callee.type === 'Identifier' && callee.name === 'require') {
          const arg = pathNode.node.arguments[0];
          if (arg && arg.type === 'StringLiteral') {
            dependencies.push({
              specifier: arg.value,
              type: 'static',
              statement: code.slice(pathNode.node.start ?? 0, pathNode.node.end ?? 0),
              loc: pathNode.node.loc
                ? { line: pathNode.node.loc.start.line, column: pathNode.node.loc.start.column }
                : undefined
            });
          }
        }
      }
    });
  }

  if (STYLE_EXTENSIONS.has(posixExtname(filePath))) {
    const regex = /@import\s+(?:url\()?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(code))) {
      dependencies.push({
        specifier: match[1],
        type: 'style',
        statement: match[0]
      });
    }
  }

  return dependencies;
};

const extractSymbols = (filePath: string, code: string): SymbolInfo[] => {
  if (!SCRIPT_EXTENSIONS.has(posixExtname(filePath))) return [];

  let ast: File | null = null;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: [
        'jsx',
        'typescript',
        'dynamicImport',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'importAssertions',
        'topLevelAwait'
      ]
    });
  } catch {
    return [];
  }

  const localKinds = new Map<string, string>();
  traverse(ast, {
    FunctionDeclaration(pathNode) {
      if (pathNode.parent.type !== 'Program') return;
      if (pathNode.node.id) localKinds.set(pathNode.node.id.name, 'function');
    },
    ClassDeclaration(pathNode) {
      if (pathNode.parent.type !== 'Program') return;
      if (pathNode.node.id) localKinds.set(pathNode.node.id.name, 'class');
    },
    VariableDeclaration(pathNode) {
      if (pathNode.parent.type !== 'Program') return;
      const kind = pathNode.node.kind;
      pathNode.node.declarations.forEach((decl) => {
        if (decl.id.type === 'Identifier') {
          localKinds.set(decl.id.name, kind);
        }
      });
    },
    TSInterfaceDeclaration(pathNode) {
      if (pathNode.parent.type !== 'Program') return;
      localKinds.set(pathNode.node.id.name, 'interface');
    },
    TSTypeAliasDeclaration(pathNode) {
      if (pathNode.parent.type !== 'Program') return;
      localKinds.set(pathNode.node.id.name, 'type');
    },
    TSEnumDeclaration(pathNode) {
      if (pathNode.parent.type !== 'Program') return;
      localKinds.set(pathNode.node.id.name, 'enum');
    }
  });

  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();

  const addSymbol = (symbol: SymbolInfo) => {
    if (seen.has(symbol.name)) return;
    seen.add(symbol.name);
    symbols.push(symbol);
  };

  traverse(ast, {
    ExportNamedDeclaration(pathNode) {
      const decl = pathNode.node.declaration;
      if (decl) {
        if (decl.type === 'FunctionDeclaration' && decl.id) {
          addSymbol({ name: decl.id.name, kind: 'function' });
        } else if (decl.type === 'ClassDeclaration' && decl.id) {
          addSymbol({ name: decl.id.name, kind: 'class' });
        } else if (decl.type === 'VariableDeclaration') {
          decl.declarations.forEach((item) => {
            if (item.id.type === 'Identifier') {
              addSymbol({ name: item.id.name, kind: decl.kind });
            }
          });
        } else if (decl.type === 'TSInterfaceDeclaration') {
          addSymbol({ name: decl.id.name, kind: 'interface' });
        } else if (decl.type === 'TSTypeAliasDeclaration') {
          addSymbol({ name: decl.id.name, kind: 'type' });
        } else if (decl.type === 'TSEnumDeclaration') {
          addSymbol({ name: decl.id.name, kind: 'enum' });
        }
        return;
      }

      if (pathNode.node.specifiers.length) {
        pathNode.node.specifiers.forEach((specifier) => {
          if (specifier.type !== 'ExportSpecifier') return;
          const exportedName =
            specifier.exported.type === 'Identifier'
              ? specifier.exported.name
              : specifier.exported.value;
          const localName =
            specifier.local.type === 'Identifier'
              ? specifier.local.name
              : specifier.local.value;
          addSymbol({
            name: exportedName,
            kind: localKinds.get(localName) ?? 'export'
          });
        });
      }
    },
    ExportDefaultDeclaration(pathNode) {
      const decl = pathNode.node.declaration;
      if (decl.type === 'FunctionDeclaration') {
        addSymbol({
          name: 'default',
          kind: 'function',
          displayName: decl.id?.name
        });
      } else if (decl.type === 'ClassDeclaration') {
        addSymbol({
          name: 'default',
          kind: 'class',
          displayName: decl.id?.name
        });
      } else if (decl.type === 'Identifier') {
        addSymbol({
          name: 'default',
          kind: localKinds.get(decl.name) ?? 'export',
          displayName: decl.name
        });
      } else {
        addSymbol({ name: 'default', kind: 'export' });
      }
    }
  });

  return symbols;
};

const resolveWithExtensions = (
  basePath: string | null,
  fileSet: Set<string>,
  dirSet: Set<string>
) => {
  if (!basePath) return null;
  if (fileSet.has(basePath)) return basePath;

  if (dirSet.has(basePath)) {
    for (const ext of IMPORT_EXTENSIONS) {
      const indexPath = posixJoin(basePath, `index${ext}`);
      if (fileSet.has(indexPath)) return indexPath;
    }
  }

  if (!posixExtname(basePath)) {
    for (const ext of IMPORT_EXTENSIONS) {
      const filePath = `${basePath}${ext}`;
      if (fileSet.has(filePath)) return filePath;
    }
  }

  return null;
};

const resolveImport = (
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
  dirSet: Set<string>
) => {
  if (!specifier || specifier.startsWith('http')) return null;

  const cleanSpecifier = specifier.split('?')[0].split('#')[0];
  let targetPath: string | null = null;
  let escapedRoot = false;

  if (cleanSpecifier.startsWith('@/')) {
    const normalized = normalizePosixPath(cleanSpecifier.slice(2));
    targetPath = normalized.path;
    escapedRoot = normalized.escapedRoot;
  } else if (cleanSpecifier.startsWith('/')) {
    const normalized = normalizePosixPath(cleanSpecifier.slice(1));
    targetPath = normalized.path;
    escapedRoot = normalized.escapedRoot;
  } else if (cleanSpecifier.startsWith('.')) {
    const fromDir = posixDirname(fromFile);
    const normalized = normalizePosixPath(posixJoin(fromDir, cleanSpecifier));
    targetPath = normalized.path;
    escapedRoot = normalized.escapedRoot;
  } else {
    return { external: true, resolved: null };
  }

  if (!targetPath || escapedRoot) {
    return { external: true, resolved: null };
  }

  const resolved = resolveWithExtensions(targetPath, fileSet, dirSet);
  if (!resolved) return { external: true, resolved: null };

  return { external: false, resolved };
};

const hashId = (value: string) => {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
};

export const scanDirectoryHandle = async (
  options: BrowserScanOptions
): Promise<GraphData> => {
  const { rootHandle, maxFiles, includeExternal } = options;
  const granularity = options.granularity ?? 'file';
  const rootLabel = rootHandle.name || 'Selected folder';

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const ignoredNodes: GraphNode[] = [];
  const fileHandles = new Map<string, FileSystemFileHandle>();
  const fileContents = new Map<string, string>();
  const dirSet = new Set<string>(['']);
  const symbolMap = new Map<string, Map<string, SymbolInfo>>();

  let totalFiles = 0;
  let ignoredCount = 0;
  let externalCount = 0;

  const walk = async (
    dirHandle: FileSystemDirectoryHandle,
    relDir: string,
    patterns: string[]
  ) => {
    dirSet.add(relDir);

    const gitignoreHandle = await dirHandle
      .getFileHandle('.gitignore')
      .catch(() => null);
    let combinedPatterns = patterns;

    if (gitignoreHandle) {
      const gitignoreFile = await gitignoreHandle.getFile().catch(() => null);
      const gitignoreContent = await gitignoreFile?.text();
      if (gitignoreContent) {
        const extraPatterns = gitignoreContent
          .split(/\r?\n/)
          .map((line) => normalizeGitignorePattern(relDir, line))
          .filter((value): value is string => Boolean(value));
        combinedPatterns = patterns.concat(extraPatterns);
      }
    }

    const ig = ignore().add(combinedPatterns);

    for await (const [name, handle] of dirHandle.entries()) {
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (!relPath) continue;

      if (ig.ignores(relPath)) {
        ignoredCount += 1;
        if (handle.kind === 'file' && SUPPORTED_EXTENSIONS.has(posixExtname(relPath))) {
          ignoredNodes.push({
            id: relPath,
            path: relPath,
            label: posixBasename(relPath),
            type: nodeTypeFromPath(relPath),
            ignored: true
          });
        }
        continue;
      }

      if (handle.kind === 'directory') {
        await walk(handle, relPath, combinedPatterns);
        continue;
      }

      totalFiles += 1;
      if (totalFiles > maxFiles) {
        throw new Error(
          `File limit exceeded (${maxFiles}). Adjust the max files setting to continue.`
        );
      }

      if (!SUPPORTED_EXTENSIONS.has(posixExtname(relPath))) continue;

      nodes.set(relPath, {
        id: relPath,
        path: relPath,
        label: posixBasename(relPath),
        type: nodeTypeFromPath(relPath)
      });

      fileHandles.set(relPath, handle);
    }
  };

  await walk(rootHandle, '', ALWAYS_IGNORE);

  for (const ignoredNode of ignoredNodes) {
    nodes.set(ignoredNode.id, ignoredNode);
  }

  const fileSet = new Set(fileHandles.keys());

  if (granularity === 'symbol') {
    for (const [relPath, handle] of fileHandles.entries()) {
      const file = await handle.getFile().catch(() => null);
      const code = await file?.text();
      if (!code) continue;
      fileContents.set(relPath, code);

      const symbols = extractSymbols(relPath, code);
      if (!symbols.length) continue;

      const entry = new Map<string, SymbolInfo>();
      for (const symbol of symbols) {
        const symbolId = `${relPath}::${symbol.name}`;
        entry.set(symbol.name, symbol);
        if (!nodes.has(symbolId)) {
          nodes.set(symbolId, {
            id: symbolId,
            path: `${relPath}#${symbol.name}`,
            label: symbol.name,
            type: 'symbol',
            symbolKind: symbol.kind,
            parent: relPath,
            displayName: symbol.displayName
          });
        }
        const containsKey = `${relPath}|${symbolId}|contains`;
        if (!edgeKeys.has(containsKey)) {
          edgeKeys.add(containsKey);
          edges.push({
            id: hashId(containsKey),
            source: relPath,
            target: symbolId,
            type: 'contains'
          });
        }
      }
      symbolMap.set(relPath, entry);
    }
  }

  for (const [relPath, handle] of fileHandles.entries()) {
    const file = await handle.getFile().catch(() => null);
    const code = fileContents.get(relPath) ?? (await file?.text());
    if (!code) continue;

    const dependencies = extractDependencies(relPath, code);

    for (const dep of dependencies) {
      const resolved = resolveImport(relPath, dep.specifier, fileSet, dirSet);
      if (!resolved) continue;

      if (resolved.external) {
        externalCount += 1;
        if (!includeExternal) continue;

        if (!nodes.has('__external__')) {
          nodes.set('__external__', {
            id: '__external__',
            path: '__external__',
            label: 'External',
            type: 'external'
          });
        }

        const edgeKey = `${relPath}|__external__|external|${dep.specifier}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);
        edges.push({
          id: hashId(edgeKey),
          source: relPath,
          target: '__external__',
          type: 'external',
          statement: dep.statement,
          loc: dep.loc
        });
        continue;
      }

      if (!resolved.resolved) continue;

      const targetRel = resolved.resolved;
      if (!nodes.has(targetRel)) {
        nodes.set(targetRel, {
          id: targetRel,
          path: targetRel,
          label: posixBasename(targetRel),
          type: nodeTypeFromPath(targetRel)
        });
      }

      if (granularity === 'symbol' && dep.imports?.length) {
        const targetSymbols = symbolMap.get(targetRel);
        let createdSymbolEdge = false;
        if (targetSymbols) {
          for (const binding of dep.imports) {
            if (binding.kind === 'namespace') continue;
            const importName = binding.kind === 'default' ? 'default' : binding.imported;
            const symbol = targetSymbols.get(importName);
            if (!symbol) continue;
            const symbolId = `${targetRel}::${importName}`;
            const edgeKey = `${relPath}|${symbolId}|${dep.type}|${dep.statement ?? ''}`;
            if (edgeKeys.has(edgeKey)) continue;
            edgeKeys.add(edgeKey);
            edges.push({
              id: hashId(edgeKey),
              source: relPath,
              target: symbolId,
              type: dep.type,
              statement: dep.statement?.slice(0, 200),
              loc: dep.loc
            });
            createdSymbolEdge = true;
          }
        }

        if (createdSymbolEdge) continue;
      }

      const targetExt = posixExtname(targetRel);
      const edgeType: EdgeType = STYLE_EXTENSIONS.has(targetExt) ? 'style' : dep.type;

      const edgeKey = `${relPath}|${targetRel}|${edgeType}|${dep.statement ?? ''}`;
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);

      edges.push({
        id: hashId(edgeKey),
        source: relPath,
        target: targetRel,
        type: edgeType,
        statement: dep.statement?.slice(0, 200),
        loc: dep.loc
      });
    }
  }

  return {
    root: rootLabel,
    nodes: Array.from(nodes.values()),
    edges,
    totalFiles,
    ignoredCount,
    externalCount
  };
};
