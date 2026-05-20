/**
 * Arithmetic + comparison expression evaluator for the `formula` primitive.
 *
 * Used by body section-rules to validate computed fields, e.g.:
 *   "score == reach * impact * confidence / effort"
 *   "total == a + b + c"
 *   "(x + y) * 2 >= threshold"
 *
 * Grammar (recursive descent, standard precedence):
 *
 *   expr        := comparison
 *   comparison  := add_expr ( ('==' | '!=' | '<=' | '>=' | '<' | '>') add_expr )?
 *   add_expr    := mul_expr ( ('+' | '-') mul_expr )*
 *   mul_expr    := unary  ( ('*' | '/') unary )*
 *   unary       := '-'? primary
 *   primary     := NUMBER | IDENT | '(' expr ')'
 *
 * Identifiers resolve from a `values` object argument.
 * Numeric == / != uses epsilon tolerance 1e-9 (spec §6.6).
 *
 * Modeled on lib/conditional-eval.js — same recursive-descent style, no deps.
 */

const EPSILON = 1e-9;

/**
 * Parse and evaluate an expression against a values object.
 * @param {string} expression
 * @param {Record<string, number>} values
 * @returns {boolean|number} — comparison yields boolean; pure arithmetic yields number
 */
export function evaluate(expression, values) {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const ast = parser.parseExpression();
  if (!parser.atEnd()) {
    throw new Error(
      `Unexpected token at end of expression: ${JSON.stringify(parser.peek())}`,
    );
  }
  return evalAst(ast, values);
}

/**
 * Parse an expression and return its AST. Throws on syntax error.
 * Used by meta-validation to pre-check a formula string.
 * @param {string} expression
 * @returns {object} AST node
 */
export function parse(expression) {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const ast = parser.parseExpression();
  if (!parser.atEnd()) {
    throw new Error(
      `Unexpected token at end of expression: ${JSON.stringify(parser.peek())}`,
    );
  }
  return ast;
}

// ────────────────────────────────────────────────────────────────────────────
// Lexer
// ────────────────────────────────────────────────────────────────────────────

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];

    // Whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Two-character operators (must be checked before single-char)
    if (i + 1 < input.length) {
      const two = input[i] + input[i + 1];
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        tokens.push({ type: two });
        i += 2;
        continue;
      }
    }

    // Single-character operators and grouping
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "<" || c === ">" || c === "(" || c === ")") {
      tokens.push({ type: c });
      i++;
      continue;
    }

    // Numbers (integer or decimal)
    if (/[0-9]/.test(c) || (c === "." && i + 1 < input.length && /[0-9]/.test(input[i + 1]))) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      if (j < input.length && input[j] === ".") {
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      tokens.push({ type: "NUMBER", value: parseFloat(input.slice(i, j)) });
      i = j;
      continue;
    }

    // Identifiers (letters, digits, underscores; must start with letter or underscore)
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ type: "IDENT", value: input.slice(i, j) });
      i = j;
      continue;
    }

    throw new Error(`Unexpected character '${c}' at index ${i}`);
  }
  return tokens;
}

// ────────────────────────────────────────────────────────────────────────────
// Parser (recursive descent)
// ────────────────────────────────────────────────────────────────────────────

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  advance() {
    return this.tokens[this.pos++];
  }

  atEnd() {
    return this.pos >= this.tokens.length;
  }

  expect(type) {
    if (this.peek()?.type !== type) {
      throw new Error(
        `Expected token '${type}', got ${JSON.stringify(this.peek())}`,
      );
    }
    return this.advance();
  }

  match(...types) {
    if (this.peek() && types.includes(this.peek().type)) {
      return this.advance();
    }
    return null;
  }

  // expr := comparison
  parseExpression() {
    return this.parseComparison();
  }

  // comparison := add_expr ( ('==' | '!=' | '<=' | '>=' | '<' | '>') add_expr )?
  parseComparison() {
    let left = this.parseAdditive();
    const op = this.match("==", "!=", "<=", ">=", "<", ">");
    if (op) {
      const right = this.parseAdditive();
      return { type: "compare", op: op.type, left, right };
    }
    return left;
  }

  // add_expr := mul_expr ( ('+' | '-') mul_expr )*
  parseAdditive() {
    let left = this.parseMultiplicative();
    let op;
    while ((op = this.match("+", "-"))) {
      const right = this.parseMultiplicative();
      left = { type: "binary", op: op.type, left, right };
    }
    return left;
  }

  // mul_expr := unary ( ('*' | '/') unary )*
  parseMultiplicative() {
    let left = this.parseUnary();
    let op;
    while ((op = this.match("*", "/"))) {
      const right = this.parseUnary();
      left = { type: "binary", op: op.type, left, right };
    }
    return left;
  }

  // unary := '-'? primary
  parseUnary() {
    if (this.match("-")) {
      const operand = this.parsePrimary();
      return { type: "unary", op: "-", operand };
    }
    return this.parsePrimary();
  }

  // primary := NUMBER | IDENT | '(' expr ')'
  parsePrimary() {
    const tok = this.peek();
    if (!tok) {
      throw new Error("Unexpected end of expression");
    }

    if (tok.type === "NUMBER") {
      this.advance();
      return { type: "number", value: tok.value };
    }

    if (tok.type === "IDENT") {
      this.advance();
      return { type: "ident", name: tok.value };
    }

    if (tok.type === "(") {
      this.advance();
      const expr = this.parseExpression();
      this.expect(")");
      return expr;
    }

    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Evaluator
// ────────────────────────────────────────────────────────────────────────────

function evalAst(ast, values) {
  switch (ast.type) {
    case "number":
      return ast.value;

    case "ident": {
      const val = values[ast.name];
      if (val === undefined) {
        throw new Error(`Unknown identifier '${ast.name}'`);
      }
      return val;
    }

    case "unary": {
      const operand = evalAst(ast.operand, values);
      return -operand;
    }

    case "binary": {
      const left = evalAst(ast.left, values);
      const right = evalAst(ast.right, values);
      switch (ast.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        default:
          throw new Error(`Unknown binary operator: ${ast.op}`);
      }
    }

    case "compare": {
      const left = evalAst(ast.left, values);
      const right = evalAst(ast.right, values);
      switch (ast.op) {
        case "==": return Math.abs(left - right) < EPSILON;
        case "!=": return Math.abs(left - right) >= EPSILON;
        case "<":  return left < right;
        case ">":  return left > right;
        case "<=": return left <= right;
        case ">=": return left >= right;
        default:
          throw new Error(`Unknown comparison operator: ${ast.op}`);
      }
    }

    default:
      throw new Error(`Unknown AST node type: ${ast.type}`);
  }
}
