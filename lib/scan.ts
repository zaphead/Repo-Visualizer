import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import ignore from 'ignore';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type { File } from '@babel/types';
import type { GraphData, GraphEdge, GraphNode, EdgeType } from './types';

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

export type ScanGranularity = 'file' | 'symbol';

export type ScanOptions = {
  root: string;
  maxFiles: number;
  includeExternal: boolean;
  granularity?: ScanGranularity;
};

export type Dependency = {
  specifier: string;
  type: EdgeType;
  statement?: string;
  loc?: { line: number; column: number };
  imports?: ImportBinding[];
};

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

const posixPath = (value: string) => value.split(path.sep).join('/');

const hashId = (value: string) =>
  createHash('sha1').update(value).digest('hex');

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
      prefixed = path.posix.join(base, pattern);
    } else {
      prefixed = path.posix.join(base, '**', pattern);
    }
  } else if (!anchored && !hasSlash) {
    prefixed = path.posix.join('**', pattern);
  }

  if (endsWithSlash && !prefixed.endsWith('/')) {
    prefixed += '/';
  }

  return negated ? `!${prefixed}` : prefixed;
};

const isSupportedFile = (filePath: string) =>
  SUPPORTED_EXTENSIONS.has(path.extname(filePath));

const nodeTypeFromPath = (relPath: string) => {
  if (relPath === '__external__') return 'external';
  if (ROUTE_REGEX.app.test(relPath) || ROUTE_REGEX.pages.test(relPath)) {
    if (relPath.includes('/pages/') || relPath.startsWith('pages/')) {
      const basename = path.posix.basename(relPath);
      if (basename.startsWith('_')) return 'module';
    }
    return 'route';
  }
  if (STYLE_EXTENSIONS.has(path.extname(relPath))) return 'style';
  return 'module';
};

const resolveImport = async (root: string, fromFile: string, specifier: string) => {
  if (!specifier || specifier.startsWith('http')) return null;

  const cleanSpecifier = specifier.split('?')[0].split('#')[0];
  let targetPath: string | null = null;

  if (cleanSpecifier.startsWith('@/')) {
    targetPath = path.join(root, cleanSpecifier.slice(2));
  } else if (cleanSpecifier.startsWith('/')) {
    targetPath = path.join(root, cleanSpecifier.slice(1));
  } else if (cleanSpecifier.startsWith('.')) {
    targetPath = path.resolve(path.dirname(fromFile), cleanSpecifier);
  } else {
    return { external: true, resolved: null };
  }

  const resolved = await resolveWithExtensions(targetPath);
  if (!resolved) return { external: true, resolved: null };

  if (!resolved.startsWith(root)) {
    return { external: true, resolved: null };
  }

  return { external: false, resolved };
};

const resolveWithExtensions = async (basePath: string | null) => {
  if (!basePath) return null;
  const stat = await fs
    .stat(basePath)
    .then((value) => value)
    .catch(() => null);

  if (stat?.isFile()) return basePath;

  if (stat?.isDirectory()) {
    for (const ext of IMPORT_EXTENSIONS) {
      const indexPath = path.join(basePath, `index${ext}`);
      const exists = await fs
        .stat(indexPath)
        .then((value) => value.isFile())
        .catch(() => false);
      if (exists) return indexPath;
    }
  }

  if (!path.extname(basePath)) {
    for (const ext of IMPORT_EXTENSIONS) {
      const filePath = `${basePath}${ext}`;
      const exists = await fs
        .stat(filePath)
        .then((value) => value.isFile())
        .catch(() => false);
      if (exists) return filePath;
    }
  }

  return null;
};

const extractDependencies = (filePath: string, code: string): Dependency[] => {
  const dependencies: Dependency[] = [];

  if (SCRIPT_EXTENSIONS.has(path.extname(filePath))) {
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

  if (STYLE_EXTENSIONS.has(path.extname(filePath))) {
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
  if (!SCRIPT_EXTENSIONS.has(path.extname(filePath))) return [];

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

export const detectRepoRoot = async (inputPath: string) => {
  let current = path.resolve(inputPath);
  let prev = '';

  while (current !== prev) {
    const gitPath = path.join(current, '.git');
    const exists = await fs
      .stat(gitPath)
      .then((value) => value.isDirectory())
      .catch(() => false);
    if (exists) return current;
    prev = current;
    current = path.dirname(current);
  }

  return null;
};

export const scanProject = async (options: ScanOptions): Promise<GraphData> => {
  const root = path.resolve(options.root);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error('Selected path is not a readable directory.');
  }

  const granularity = options.granularity ?? 'file';

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const ignoredNodes: GraphNode[] = [];
  const symbolMap = new Map<string, Map<string, SymbolInfo>>();
  const fileContents = new Map<string, string>();

  let totalFiles = 0;
  let ignoredCount = 0;
  let externalCount = 0;

  const basePatterns = [...ALWAYS_IGNORE];

  const filesToParse: string[] = [];

  const walk = async (dir: string, patterns: string[]) => {
    const relDir = posixPath(path.relative(root, dir));
    const gitignorePath = path.join(dir, '.gitignore');
    let combinedPatterns = patterns;

    const gitignoreContent = await fs
      .readFile(gitignorePath, 'utf8')
      .catch(() => null);

    if (gitignoreContent) {
      const extraPatterns = gitignoreContent
        .split(/\r?\n/)
        .map((line) => normalizeGitignorePattern(relDir, line))
        .filter((value): value is string => Boolean(value));
      combinedPatterns = patterns.concat(extraPatterns);
    }

    const ig = ignore().add(combinedPatterns);

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = posixPath(path.relative(root, fullPath));

      if (!relPath) continue;

      const ignored = ig.ignores(relPath);

      if (ignored) {
        ignoredCount += 1;
        if (!entry.isDirectory() && isSupportedFile(fullPath)) {
          ignoredNodes.push({
            id: relPath,
            path: relPath,
            label: path.posix.basename(relPath),
            type: nodeTypeFromPath(relPath),
            ignored: true
          });
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath, combinedPatterns);
        continue;
      }

      totalFiles += 1;
      if (totalFiles > options.maxFiles) {
        throw new Error(
          `File limit exceeded (${options.maxFiles}). Adjust the max files setting to continue.`
        );
      }

      if (!isSupportedFile(fullPath)) continue;

      nodes.set(relPath, {
        id: relPath,
        path: relPath,
        label: path.posix.basename(relPath),
        type: nodeTypeFromPath(relPath)
      });

      filesToParse.push(fullPath);
    }
  };

  await walk(root, basePatterns);

  for (const ignoredNode of ignoredNodes) {
    nodes.set(ignoredNode.id, ignoredNode);
  }

  if (granularity === 'symbol') {
    for (const fullPath of filesToParse) {
      const relPath = posixPath(path.relative(root, fullPath));
      const code = await fs.readFile(fullPath, 'utf8').catch(() => null);
      if (!code) continue;
      fileContents.set(fullPath, code);

      const symbols = extractSymbols(fullPath, code);
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

  for (const fullPath of filesToParse) {
    const relPath = posixPath(path.relative(root, fullPath));
    const code =
      fileContents.get(fullPath) ?? (await fs.readFile(fullPath, 'utf8').catch(() => null));
    if (!code) continue;

    const dependencies = extractDependencies(fullPath, code);

    for (const dep of dependencies) {
      const resolved = await resolveImport(root, fullPath, dep.specifier);
      if (!resolved) continue;

      if (resolved.external) {
        externalCount += 1;
        if (!options.includeExternal) continue;

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

      const targetRel = posixPath(path.relative(root, resolved.resolved));
      if (!nodes.has(targetRel)) {
        nodes.set(targetRel, {
          id: targetRel,
          path: targetRel,
          label: path.posix.basename(targetRel),
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

      const targetExt = path.extname(targetRel);
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
    root,
    nodes: Array.from(nodes.values()),
    edges,
    totalFiles,
    ignoredCount,
    externalCount
  };
};
