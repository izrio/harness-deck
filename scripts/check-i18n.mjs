#!/usr/bin/env node
/**
 * i18n 校验（HD-04）：
 * 1. zh / en 的占位符必须一致（`{0}`、`{0:file|files}`、`{agent}`）；
 * 2. 同一个文件里不能有重复 key；
 * 3. 代码里没用到的 key 给出警告（CI 不因此失败）。
 *
 * 缺失 en key 已经由 `pnpm typecheck` 的类型约束挡住，这里不重复报错。
 * 用法：`pnpm check:i18n`；加 `--strict` 让未使用 key 也返回非零。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict');

const CATALOGS = [
  {
    name: 'extension',
    file: 'packages/extension/src/i18n.ts',
    roots: ['packages/extension/src'],
  },
  {
    name: 'webview-ui',
    file: 'packages/webview-ui/src/i18n.ts',
    roots: ['packages/webview-ui/src'],
  },
];

function foldString(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldString(node.left);
    const right = foldString(node.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

function propertyName(name) {
  if (!name) return undefined;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isIdentifier(name)) return name.text;
  return undefined;
}

function readObject(node) {
  const entries = [];
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      entries.push({ key: undefined, value: undefined, line: 0 });
      continue;
    }
    entries.push({
      key: propertyName(prop.name),
      value: foldString(prop.initializer),
      line: prop.getStart(),
    });
  }
  return entries;
}

function parseCatalog(file) {
  const absolute = join(ROOT, file);
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const objects = {};
  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          (decl.name.text === 'zh' || decl.name.text === 'en') &&
          decl.initializer &&
          ts.isObjectLiteralExpression(decl.initializer)
        ) {
          objects[decl.name.text] = readObject(decl.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return objects;
}

function placeholders(value) {
  const set = new Set();
  for (const match of value.matchAll(/\{(\d+|agent)(?::[^}]*)?\}/gu)) {
    set.add(match[1]);
  }
  return [...set].sort();
}

function listSourceFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
      } else if (/\.(?:ts|tsx)$/u.test(entry)) {
        out.push(path);
      }
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/** 收集代码里的字符串字面量与模板前缀，用来判断 key 是否被用到。 */
function collectUsages(catalogFile, roots) {
  const literals = new Set();
  const prefixes = new Set();
  for (const root of roots) {
    for (const file of listSourceFiles(root)) {
      if (join(ROOT, catalogFile) === file) continue;
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          literals.add(node.text);
        } else if (ts.isTemplateExpression(node)) {
          const head = node.head.text;
          if (head.length >= 3 && head.includes('.')) prefixes.add(head);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return { literals, prefixes };
}

let failed = false;
let warned = false;

for (const catalog of CATALOGS) {
  const objects = parseCatalog(catalog.file);
  const zh = objects.zh ?? [];
  const en = objects.en ?? [];
  const label = relative(ROOT, join(ROOT, catalog.file));
  const errors = [];
  const warnings = [];

  if (zh.length === 0 || en.length === 0) {
    errors.push('找不到 zh / en 对象（文件结构变了，请更新 scripts/check-i18n.mjs）');
  }

  const seen = new Map();
  for (const entry of zh) {
    if (!entry.key) {
      errors.push('zh 里有非字面量 key，无法静态检查');
      continue;
    }
    if (seen.has(entry.key)) {
      errors.push(`zh 重复 key: ${entry.key}（偏移 ${seen.get(entry.key)} 与 ${entry.line}）`);
    } else {
      seen.set(entry.key, entry.line);
    }
  }

  const enMap = new Map();
  for (const entry of en) {
    if (!entry.key) {
      errors.push('en 里有非字面量 key，无法静态检查');
      continue;
    }
    if (enMap.has(entry.key)) errors.push(`en 重复 key: ${entry.key}`);
    else enMap.set(entry.key, entry);
  }

  const zhMap = new Map(zh.filter((e) => e.key).map((e) => [e.key, e]));
  for (const entry of zh) {
    if (!entry.key) continue;
    const other = enMap.get(entry.key);
    if (!other) {
      errors.push(`en 缺少 key: ${entry.key}`);
      continue;
    }
    if (entry.value === undefined || other.value === undefined) {
      warnings.push(`占位符无法静态检查（值不是字符串字面量）: ${entry.key}`);
      continue;
    }
    const a = placeholders(entry.value);
    const b = placeholders(other.value);
    if (a.join(',') !== b.join(',')) {
      errors.push(`占位符不一致: ${entry.key}（zh {${a.join('}{')}} vs en {${b.join('}{')}}）`);
    }
  }
  for (const key of enMap.keys()) {
    if (!zhMap.has(key)) errors.push(`en 多出的 key: ${key}`);
  }

  const { literals, prefixes } = collectUsages(catalog.file, catalog.roots);
  for (const entry of zh) {
    if (!entry.key) continue;
    if (literals.has(entry.key)) continue;
    if ([...prefixes].some((prefix) => entry.key.startsWith(prefix))) continue;
    warnings.push(`未使用的 key: ${entry.key}`);
  }

  console.log(`\n${catalog.name} (${label})：${zh.length} 个 key`);
  for (const message of errors) console.log(`  ✗ ${message}`);
  for (const message of warnings) console.log(`  ! ${message}`);
  if (errors.length === 0 && warnings.length === 0) console.log('  ✓ 通过');

  if (errors.length > 0) failed = true;
  if (warnings.length > 0) warned = true;
}

if (STRICT && warned) failed = true;
if (failed) {
  console.error('\ni18n 校验失败。');
  process.exitCode = 1;
}
