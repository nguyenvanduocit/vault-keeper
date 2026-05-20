/**
 * Tiny DSL evaluator for template field schema `when` conditions.
 *
 * Used by conditional `required.when` strings such as:
 *   "prd_type in ['feature', 'enhancement']"
 *   "prd_type in ['feature'] and status not in ['draft', 'review']"
 *
 * Grammar (recursive descent):
 *
 *   expr        := or_expr
 *   or_expr     := and_expr ( 'or' and_expr )*
 *   and_expr    := comparison ( 'and' comparison )*
 *   comparison  := field ( 'in' | 'not' 'in' ) list
 *   list        := '[' ( string ( ',' string )* )? ']'
 *   field       := IDENT ( '.' IDENT )*
 *   string      := single-quoted | double-quoted
 *
 * The grammar is intentionally narrow — extended only when a real template
 * needs more (no speculative operators).
 */

export function evaluate(expression, context) {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const ast = parser.parseOr();
  if (!parser.atEnd()) {
    throw new Error(
      `Unexpected token at end of expression: ${JSON.stringify(parser.peek())}`,
    );
  }
  return evalAst(ast, context);
}

export function getField(obj, path) {
  if (obj == null) return undefined;
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

// ────────────────────────────────────────────────────────────────────────────
// Lexer
// ────────────────────────────────────────────────────────────────────────────

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (c === "[" || c === "]" || c === ",") {
      tokens.push({ type: c });
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== c) j++;
      if (j >= input.length) {
        throw new Error(`Unterminated string starting at index ${i}`);
      }
      tokens.push({ type: "STRING", value: input.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[\w.]/.test(input[j])) j++;
      const word = input.slice(i, j);
      if (word === "and" || word === "or" || word === "in" || word === "not") {
        tokens.push({ type: word });
      } else {
        tokens.push({ type: "IDENT", value: word });
      }
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

  parseOr() {
    let left = this.parseAnd();
    while (this.match("or")) {
      const right = this.parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseComparison();
    while (this.match("and")) {
      const right = this.parseComparison();
      left = { type: "and", left, right };
    }
    return left;
  }

  parseComparison() {
    const fieldTok = this.expect("IDENT");
    const field = fieldTok.value;

    let op;
    if (this.match("not")) {
      this.expect("in");
      op = "not_in";
    } else if (this.match("in")) {
      op = "in";
    } else {
      throw new Error(
        `Expected 'in' or 'not in' after field '${field}', got ${JSON.stringify(this.peek())}`,
      );
    }

    this.expect("[");
    const values = [];
    if (this.peek()?.type !== "]") {
      values.push(this.expect("STRING").value);
      while (this.match(",")) {
        values.push(this.expect("STRING").value);
      }
    }
    this.expect("]");

    return { type: op, field, values };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Evaluator
// ────────────────────────────────────────────────────────────────────────────

function evalAst(ast, context) {
  switch (ast.type) {
    case "and":
      return evalAst(ast.left, context) && evalAst(ast.right, context);
    case "or":
      return evalAst(ast.left, context) || evalAst(ast.right, context);
    case "in":
      return ast.values.includes(getField(context, ast.field));
    case "not_in":
      return !ast.values.includes(getField(context, ast.field));
    default:
      throw new Error(`Unknown AST node type: ${ast.type}`);
  }
}
