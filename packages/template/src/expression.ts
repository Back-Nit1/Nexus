// Scoring expression language v1: variables motion|sharpness|brightness, operators + - * / and parentheses.
// Hand-written recursive descent parser. No eval, no Function.

export const VARIABLES = ["motion", "sharpness", "brightness"] as const;
export type Scores = Record<(typeof VARIABLES)[number], number>;
export type Expr = { v: keyof Scores } | { op: "+" | "-" | "*" | "/"; l: Expr; r: Expr };

export class ExpressionError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

const MAX_PAREN_DEPTH = 100;

export function parseExpression(src: string): Expr {
  const tokens = [...src.matchAll(/\s*(?:([A-Za-z_]\w*)|([-+*/()])|(\S))/gy)].map((m) => ({ text: (m[1] ?? m[2] ?? m[3])!, at: m.index! + m[0].length - (m[1] ?? m[2] ?? m[3])!.length, ident: !!m[1], bad: !!m[3] }));
  let i = 0;
  let depth = 0;
  const peek = () => tokens[i];
  const fail = (msg: string): never => {
    throw new ExpressionError(msg, peek()?.at ?? src.length);
  };
  const factor = (): Expr => {
    const t = peek() ?? fail("Unexpected end of expression");
    if (t.text === "(") {
      if (++depth > MAX_PAREN_DEPTH) fail(`Expression nested too deeply (max ${MAX_PAREN_DEPTH} levels of parentheses)`);
      i++;
      const e = sum();
      if (peek()?.text !== ")") fail("Expected ')'");
      i++;
      depth--;
      return e;
    }
    if (t.ident && (VARIABLES as readonly string[]).includes(t.text)) return i++, { v: t.text as keyof Scores };
    return fail(t.ident ? `Unknown variable '${t.text}' (allowed: ${VARIABLES.join(", ")})` : `Unexpected '${t.text}'`);
  };
  const chain = (next: () => Expr, ops: string): (() => Expr) => () => {
    let e = next();
    while (peek() && ops.includes(peek().text) && !peek().ident) e = { op: tokens[i++].text as any, l: e, r: next() };
    return e;
  };
  const term = chain(factor, "*/");
  const sum = chain(term, "+-");
  if (!src.trim()) fail("Empty expression");
  const e = sum();
  if (i < tokens.length) fail(`Unexpected '${peek().text}'`);
  return e;
}

export function evaluate(e: Expr, s: Scores): number {
  if ("v" in e) return s[e.v];
  const [l, r] = [evaluate(e.l, s), evaluate(e.r, s)];
  return e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : l / r;
}
