import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.mjs';

/**
 * Shared AST layer for the gates.
 *
 * The Adversary evaded all five gates with one root cause: every check matched
 * on identifier names, so any code that avoided the naming convention walked
 * straight past. A regex cannot tell a real adapter from a fabricated one that
 * happens to be called `SesNotificationProvider`.
 *
 * Names are a hint. Structure is evidence.
 */

export async function parse(path) {
  const text = await readFile(join(REPO_ROOT, path), 'utf8');
  return {
    text,
    source: ts.createSourceFile(path, text, ts.ScriptTarget.ES2023, true),
  };
}

export function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Depth-first walk over every node. */
export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** The nearest enclosing function, method, or arrow. */
export function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Does this function body do any real work?
 *
 * A body that returns an object literal built entirely from literals — no
 * calls, no awaits, no property reads off anything — has produced plausible
 * output without doing the work. That is a mock regardless of what the class
 * is called, and it is exactly the shape the Adversary used to evade the old
 * name-based check:
 *
 *   async send(): Promise<SendResult> {
 *     return { id: 'sent_123', accepted: true };
 *   }
 */
export function doesRealWork(fn) {
  if (!fn?.body) return true; // Overload or declaration; nothing to judge.

  let real = false;

  // A body that reads its own parameters is transforming input, not
  // fabricating output. This is what separates a `.map()` callback building an
  // object from its argument — real work — from an adapter returning a fixed
  // literal regardless of what it was asked.
  const bound = new Set();
  for (const parameter of fn.parameters ?? []) {
    walk(parameter.name, (node) => {
      if (ts.isIdentifier(node)) bound.add(node.text);
    });
  }

  if (bound.size > 0) {
    walk(fn.body, (node) => {
      if (real) return;
      if (ts.isIdentifier(node) && bound.has(node.text)) real = true;
    });
    if (real) return true;
  }

  walk(fn.body, (node) => {
    if (real) return;
    if (
      ts.isCallExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isThrowStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      real = true;
    }
    // Reading state off `this` or a captured binding counts as work; returning
    // a bare literal does not.
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      real = true;
    }
  });

  return real;
}

/** Every `process.env` access, in any form — dot, bracket, or destructured. */
export function environmentAccesses(source) {
  const found = [];

  walk(source, (node) => {
    const isProcessEnv =
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) === false &&
      false;

    // process.env.FOO  and  process.env['FOO']
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'env'
    ) {
      found.push(node);
      return;
    }

    // const { FOO = 'allow' } = process.env
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'process' &&
      node.initializer.name.text === 'env'
    ) {
      found.push(node);
      return;
    }

    // { ...process.env }
    if (
      ts.isSpreadAssignment(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'env'
    ) {
      found.push(node);
    }

    void isProcessEnv;
  });

  return found;
}

const PERMISSIVE = new Set([
  'true', '1', 'yes', 'on', 'mock', 'fake', 'stub', 'dev', 'development',
  'debug', 'allow', 'permissive', 'insecure', 'none', '*', 'admin', 'root',
  'bypass', 'skip', 'disabled', 'off',
]);

export function isPermissiveLiteral(node) {
  if (!node) return false;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return PERMISSIVE.has(node.text.toLowerCase());
  }
  if (ts.isNumericLiteral(node)) return node.text === '1';
  return false;
}

/**
 * Follows an environment read into every shape a default can take: `??`, `||`,
 * a ternary, a destructuring default, or an object spread that a literal
 * overrides. The old check looked at one physical line and saw none of these.
 */
export function permissiveFallbackOf(node) {
  // Destructuring default: const { X = 'allow' } = process.env
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
    for (const element of node.name.elements) {
      if (isPermissiveLiteral(element.initializer)) return element.initializer;
    }
    return undefined;
  }

  let current = node;
  let parent = current.parent;

  while (parent) {
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      parent.left === current &&
      isPermissiveLiteral(parent.right)
    ) {
      return parent.right;
    }

    if (ts.isConditionalExpression(parent)) {
      if (isPermissiveLiteral(parent.whenFalse)) return parent.whenFalse;
      if (isPermissiveLiteral(parent.whenTrue)) return parent.whenTrue;
    }

    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) {
      current = parent;
      parent = parent.parent;
      continue;
    }

    break;
  }

  return undefined;
}

export { ts };
