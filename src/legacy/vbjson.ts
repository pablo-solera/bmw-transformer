import { vbCDec } from "./vb.js";

type Token = { type: "string" | "number" | "literal" | "punct"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c) || c === "(" || c === ")") { i++; continue; }
    if (c === "/" && input[i + 1] === "/") { i += 2; while (i < input.length && input[i] !== "\r" && input[i] !== "\n") i++; continue; }
    if (c === "/" && input[i + 1] === "*") { i += 2; while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++; i += 2; continue; }
    if (["{", "}", "[", "]", ",", ":"].includes(c)) { tokens.push({ type: "punct", value: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let raw = quote;
      i++;
      let escaped = false;
      while (i < input.length) {
        const next = input[i++]!;
        raw += next;
        if (escaped) escaped = false;
        else if (next === "\\") escaped = true;
        else if (next === quote) break;
      }
      const unquoted = raw.slice(1, raw.endsWith(quote) ? -1 : undefined);
      const jsonEscaped = quote === "'" ? unquoted.replace(/\\'/g, "'").replace(/"/g, '\\"') : unquoted;
      let value: string;
      try { value = JSON.parse(`"${jsonEscaped}"`) as string; }
      catch { throw new Error("VB6 JSON parser error: invalid quoted string"); }
      tokens.push({ type: "string", value });
      continue;
    }
    const match = input.slice(i).match(/^(?:true|false|null)\b/i);
    if (match) { tokens.push({ type: "literal", value: match[0] }); i += match[0].length; continue; }
    const numeric = input.slice(i).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numeric) { tokens.push({ type: "number", value: numeric[0] }); i += numeric[0].length; continue; }
    throw new Error(`VB6 JSON parser error: invalid token at ${i}`);
  }
  return tokens;
}

export function parseLegacyJson<T = unknown>(input: string): T {
  const tokens = tokenize(input);
  let position = 0;
  const peek = () => tokens[position];
  const consume = (expected?: string): Token => {
    const token = tokens[position++];
    if (!token || (expected && token.value !== expected)) throw new Error(`VB6 JSON parser error: expected ${expected ?? "value"}`);
    return token;
  };
  const parseValue = (): unknown => {
    const token = peek();
    if (!token) throw new Error("VB6 JSON parser error: unexpected end of input");
    if (token.value === "{") {
      consume("{");
      const object: Record<string, unknown> = {};
      if (peek()?.value === "}") { consume("}"); return object; }
      while (true) {
        const key = consume();
        if (key.type !== "string") throw new Error("VB6 JSON parser error: invalid object key");
        consume(":");
        if (Object.hasOwn(object, key.value)) throw new Error(`VB6 JSON parser duplicate key: ${key.value}`);
        object[key.value] = parseValue();
        const separator = consume().value;
        if (separator === "}") return object;
        if (separator !== ",") throw new Error("VB6 JSON parser error: expected comma");
      }
    }
    if (token.value === "[") {
      consume("[");
      const array: unknown[] = [];
      if (peek()?.value === "]") { consume("]"); return array; }
      while (true) {
        array.push(parseValue());
        const separator = consume().value;
        if (separator === "]") return array;
        if (separator !== ",") throw new Error("VB6 JSON parser error: expected comma");
      }
    }
    consume();
    if (token.type === "string") return token.value;
    if (token.type === "number") return vbCDec(token.value);
    if (token.type === "literal") {
      if (token.value.toLowerCase() === "null") return null;
      return token.value.toLowerCase() === "true";
    }
    throw new Error("VB6 JSON parser error: invalid value");
  };
  const value = parseValue();
  if (position !== tokens.length) throw new Error("VB6 JSON parser error: trailing content");
  return value as T;
}

export function legacyField(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}
