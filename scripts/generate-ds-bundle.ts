/**
 * Spec 002 — rebuilds `ui/_ds_bundle.js`, the design system's browser preview bundle (loaded by the
 * `ui/components/<group>/<group>.card.html` previews), from the `ui/components/**` sources it was exported
 * from. It reproduces the design-system export byte for byte: each module becomes one chunk, its JSX compiled
 * to `React.createElement` (Babel's classic runtime output), its imports resolved through the shared
 * `__ds_scope`, and its exports added to it. The bundle's preamble, chunk order and epilogue are kept as they
 * are — they depend only on the component list, which this repository does not change.
 *
 * Change a primitive, run this, and commit both; `components/ds-bundle.test.ts` fails when the committed
 * bundle is not this output.
 *
 * Usage: tsx scripts/generate-ds-bundle.ts           rewrites ui/_ds_bundle.js
 *        tsx scripts/generate-ds-bundle.ts --check   exits 1 if ui/_ds_bundle.js is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';

// @babel/traverse and @babel/generator (already installed with @babel/core) ship no type declarations, so the
// small surface used here is typed locally rather than adding @types packages.
interface BabelPath<N extends t.Node = t.Node> {
  node: N;
  parentPath: BabelPath;
  scope: { getBinding(name: string): unknown };
  isReferencedIdentifier(): boolean;
  isJSXOpeningElement(): boolean;
  isJSXClosingElement(): boolean;
  replaceWith(node: t.Node): void;
  skip(): void;
}
type Traverse = (ast: t.Node, visitors: Record<string, unknown>) => void;
type Generate = (ast: t.Node, options: { comments: boolean }) => { code: string };
const requireCjs = createRequire(__filename);
const cjsDefault = <T>(mod: { default?: T } & T): T => mod.default ?? mod;
const traverse = cjsDefault(requireCjs('@babel/traverse') as { default?: Traverse } & Traverse);
const generate = cjsDefault(requireCjs('@babel/generator') as { default?: Generate } & Generate);

/** Babel's inline `extends` helper, exactly as the export emits it in each chunk that spreads JSX props. */
const EXTENDS_HELPER =
  'function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }';

const CHUNK_MARKER = /^\/\/ (components\/\S+\.jsx?)$/gm;

// ---- JSX → React.createElement (classic runtime) ----

function tagExpression(name: t.JSXOpeningElement['name']): t.Expression {
  if (t.isJSXIdentifier(name)) {
    if (name.name === 'this') return t.thisExpression();
    return /^[a-z]/.test(name.name) || name.name.includes('-') ? t.stringLiteral(name.name) : t.identifier(name.name);
  }
  if (t.isJSXMemberExpression(name)) return t.memberExpression(tagExpression(name.object), t.identifier(name.property.name));
  return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
}

function attributeValue(value: t.JSXAttribute['value']): t.Expression {
  if (value === null || value === undefined) return t.booleanLiteral(true);
  if (t.isJSXExpressionContainer(value)) return value.expression as t.Expression;
  if (t.isStringLiteral(value)) {
    const literal = t.stringLiteral(value.value.replace(/\n\s+/g, ' '));
    return literal;
  }
  return value as t.Expression;
}

function attributeKey(name: t.JSXAttribute['name']): t.Identifier | t.StringLiteral {
  if (t.isJSXNamespacedName(name)) return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
  return t.isValidIdentifier(name.name, false) ? t.identifier(name.name) : t.stringLiteral(name.name);
}

/** Babel's `cleanJSXElementLiteralChild`: trims JSX text the way React does. */
function cleanText(text: string): string | null {
  const lines = text.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i += 1) if (/[^ \t]/.exec(lines[i]!)) lastNonEmptyLine = i;
  let str = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isFirstLine = i === 0;
    const isLastLine = i === lines.length - 1;
    const isLastNonEmptyLine = i === lastNonEmptyLine;
    let trimmed = line.replace(/\t/g, ' ');
    if (!isFirstLine) trimmed = trimmed.replace(/^[ ]+/, '');
    if (!isLastLine) trimmed = trimmed.replace(/[ ]+$/, '');
    if (trimmed) {
      if (!isLastNonEmptyLine) trimmed += ' ';
      str += trimmed;
    }
  }
  return str ? str : null;
}

function buildChildren(children: t.JSXElement['children']): t.Expression[] {
  const out: t.Expression[] = [];
  for (const child of children) {
    if (t.isJSXText(child)) {
      const text = cleanText(child.value);
      if (text !== null) out.push(t.stringLiteral(text));
    } else if (t.isJSXExpressionContainer(child)) {
      if (!t.isJSXEmptyExpression(child.expression)) out.push(child.expression);
    } else if (t.isJSXSpreadChild(child)) {
      out.push(t.spreadElement(child.expression) as unknown as t.Expression);
    } else {
      out.push(child as unknown as t.Expression);
    }
  }
  return out;
}

function propsExpression(attributes: t.JSXOpeningElement['attributes'], usesExtends: { value: boolean }): t.Expression {
  if (attributes.length === 0) return t.nullLiteral();
  const objects: t.Expression[] = [];
  let pending: t.ObjectProperty[] = [];
  for (const attribute of attributes) {
    if (t.isJSXSpreadAttribute(attribute)) {
      if (pending.length) objects.push(t.objectExpression(pending));
      pending = [];
      objects.push(attribute.argument);
    } else {
      pending.push(t.objectProperty(attributeKey(attribute.name), attributeValue(attribute.value)));
    }
  }
  if (pending.length) objects.push(t.objectExpression(pending));
  if (objects.length === 1) return objects[0]!;
  if (!t.isObjectExpression(objects[0])) objects.unshift(t.objectExpression([]));
  usesExtends.value = true;
  return t.callExpression(t.identifier('_extends'), objects);
}

function pure(call: t.CallExpression): t.CallExpression {
  t.addComment(call, 'leading', '#__PURE__');
  return call;
}

const createElement = () => t.memberExpression(t.identifier('React'), t.identifier('createElement'));

// ---- one module → one chunk ----

export function renderChunk(sourcePath: string, source: string): string {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const exported: string[] = [];
  const scopeImports = new Map<string, string>();
  const usesExtends = { value: false };

  // Imports: React is the page global; everything else resolves through the shared scope.
  ast.program.body = ast.program.body.flatMap((statement): t.Statement[] => {
    if (t.isImportDeclaration(statement)) {
      for (const spec of statement.specifiers) {
        if (t.isImportSpecifier(spec)) scopeImports.set(spec.local.name, t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value);
      }
      return [];
    }
    if (t.isExportNamedDeclaration(statement) && statement.declaration) {
      const declaration = statement.declaration;
      if (t.isFunctionDeclaration(declaration) && declaration.id) exported.push(declaration.id.name);
      if (t.isVariableDeclaration(declaration)) for (const d of declaration.declarations) if (t.isIdentifier(d.id)) exported.push(d.id.name);
      t.inheritsComments(declaration, statement);
      return [declaration];
    }
    return [statement];
  });

  traverse(ast, {
    Identifier(p: BabelPath<t.Identifier>) {
      const target = scopeImports.get(p.node.name);
      if (!target || !p.isReferencedIdentifier() || p.scope.getBinding(p.node.name)) return;
      p.replaceWith(t.memberExpression(t.identifier('__ds_scope'), t.identifier(target)));
      p.skip();
    },
    JSXIdentifier(p: BabelPath<t.JSXIdentifier>) {
      const target = scopeImports.get(p.node.name);
      if (!target || !p.parentPath.isJSXOpeningElement() && !p.parentPath.isJSXClosingElement()) return;
      if (p.parentPath.isJSXOpeningElement() && (p.parentPath.node as t.JSXOpeningElement).name !== p.node) return;
      p.replaceWith(t.jsxMemberExpression(t.jsxIdentifier('__ds_scope'), t.jsxIdentifier(target)));
    },
    JSXElement: {
      exit(p: BabelPath<t.JSXElement>) {
        const opening = p.node.openingElement;
        p.replaceWith(pure(t.callExpression(createElement(), [tagExpression(opening.name), propsExpression(opening.attributes, usesExtends), ...buildChildren(p.node.children)])));
      },
    },
    JSXFragment: {
      exit(p: BabelPath<t.JSXFragment>) {
        const fragment = t.memberExpression(t.identifier('React'), t.identifier('Fragment'));
        p.replaceWith(pure(t.callExpression(createElement(), [fragment, t.nullLiteral(), ...buildChildren(p.node.children)])));
      },
    },
  });

  let code = generate(ast, { comments: true }).code;
  if (usesExtends.value) code = `${EXTENDS_HELPER}\n${code}`;
  return [
    `// ${sourcePath}`,
    'try { (() => {',
    code,
    `Object.assign(__ds_scope, { ${exported.join(', ')} });`,
    `})(); } catch (e) { __ds_ns.__errors.push({ path: ${JSON.stringify(sourcePath)}, error: String((e && e.message) || e) }); }`,
  ].join('\n');
}

/** Re-renders every chunk of `bundle` from `readSource(<path under ui/>)`, keeping the preamble, order and epilogue. */
export function renderBundle(bundle: string, readSource: (sourcePath: string) => string): string {
  const markers = [...bundle.matchAll(CHUNK_MARKER)];
  if (markers.length === 0) throw new Error('generate-ds-bundle: no chunks found in ui/_ds_bundle.js.');
  const chunkEnd = (start: number) => {
    const end = bundle.indexOf('}); }\n', start);
    if (end === -1) throw new Error(`generate-ds-bundle: unterminated chunk at offset ${start}.`);
    return end + '}); }'.length;
  };
  let out = '';
  let cursor = 0;
  for (const marker of markers) {
    out += bundle.slice(cursor, marker.index);
    out += renderChunk(marker[1]!, readSource(marker[1]!));
    cursor = chunkEnd(marker.index!);
  }
  return out + bundle.slice(cursor);
}

export function run(argv: readonly string[], root = path.resolve(__dirname, '..')): number {
  const target = path.join(root, 'ui/_ds_bundle.js');
  const current = readFileSync(target, 'utf8');
  const next = renderBundle(current, (sourcePath) => readFileSync(path.join(root, 'ui', sourcePath), 'utf8').replace(/\r\n/g, '\n'));
  if (argv.includes('--check')) {
    if (current === next) return 0;
    console.error('ui/_ds_bundle.js is stale — run: npx tsx scripts/generate-ds-bundle.ts');
    return 1;
  }
  writeFileSync(target, next);
  console.log('Wrote ui/_ds_bundle.js.');
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/generate-ds-bundle.ts')) {
  process.exit(run(process.argv.slice(2)));
}
