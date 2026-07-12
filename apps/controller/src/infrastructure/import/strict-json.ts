export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface DuplicateJsonKey {
  readonly key: string;
  readonly objectPath: string;
  readonly offset: number;
}

export interface ParsedJsonDocument {
  readonly value: JsonValue;
  readonly duplicateKeys: readonly DuplicateJsonKey[];
}

export function parseJsonDocument(
  source: string,
  sourceName = "JSON input",
): ParsedJsonDocument {
  return new StrictJsonParser(source, sourceName).parse();
}

class StrictJsonParser {
  readonly #duplicates: DuplicateJsonKey[] = [];
  readonly #source: string;
  readonly #sourceName: string;
  #position = 0;

  constructor(source: string, sourceName: string) {
    this.#source = source;
    this.#sourceName = sourceName;
  }

  parse(): ParsedJsonDocument {
    this.#skipWhitespace();
    const value = this.#parseValue([]);
    this.#skipWhitespace();
    if (this.#position !== this.#source.length) {
      this.#fail("Unexpected content after the JSON value");
    }
    return { value, duplicateKeys: this.#duplicates };
  }

  #parseValue(path: readonly (string | number)[]): JsonValue {
    this.#skipWhitespace();
    const character = this.#source[this.#position];
    if (character === "{") return this.#parseObject(path);
    if (character === "[") return this.#parseArray(path);
    if (character === '"') return this.#parseString();
    if (character === "t") return this.#parseLiteral("true", true);
    if (character === "f") return this.#parseLiteral("false", false);
    if (character === "n") return this.#parseLiteral("null", null);
    return this.#parseNumber();
  }

  #parseObject(path: readonly (string | number)[]): JsonValue {
    this.#consume("{");
    this.#skipWhitespace();
    const object = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();
    if (this.#peek("}")) {
      this.#position += 1;
      return object;
    }

    while (true) {
      this.#skipWhitespace();
      const keyOffset = this.#position;
      if (!this.#peek('"')) this.#fail("Expected an object key");
      const key = this.#parseString();
      if (keys.has(key)) {
        this.#duplicates.push({
          key,
          objectPath: formatJsonPath(path),
          offset: keyOffset,
        });
      }
      keys.add(key);

      this.#skipWhitespace();
      this.#consume(":");
      object[key] = this.#parseValue([...path, key]);
      this.#skipWhitespace();
      if (this.#peek("}")) {
        this.#position += 1;
        return object;
      }
      this.#consume(",");
    }
  }

  #parseArray(path: readonly (string | number)[]): JsonValue[] {
    this.#consume("[");
    this.#skipWhitespace();
    const values: JsonValue[] = [];
    if (this.#peek("]")) {
      this.#position += 1;
      return values;
    }

    while (true) {
      values.push(this.#parseValue([...path, values.length]));
      this.#skipWhitespace();
      if (this.#peek("]")) {
        this.#position += 1;
        return values;
      }
      this.#consume(",");
    }
  }

  #parseString(): string {
    const start = this.#position;
    this.#consume('"');
    let escaped = false;
    while (this.#position < this.#source.length) {
      const character = this.#source[this.#position];
      this.#position += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        const token = this.#source.slice(start, this.#position);
        try {
          const decoded: string = JSON.parse(token);
          return decoded;
        } catch {
          this.#fail("Invalid JSON string");
        }
      } else if (character !== undefined && character.charCodeAt(0) < 0x20) {
        this.#fail("Unescaped control character in JSON string");
      }
    }
    this.#fail("Unterminated JSON string");
  }

  #parseNumber(): number {
    const remaining = this.#source.slice(this.#position);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      remaining,
    );
    if (match === null) this.#fail("Expected a JSON value");
    this.#position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.#fail("JSON number is not finite");
    return value;
  }

  #parseLiteral<T extends boolean | null>(token: string, value: T): T {
    if (!this.#source.startsWith(token, this.#position)) {
      this.#fail(`Expected ${token}`);
    }
    this.#position += token.length;
    return value;
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.#source[this.#position] ?? "")) {
      this.#position += 1;
    }
  }

  #peek(expected: string): boolean {
    return this.#source[this.#position] === expected;
  }

  #consume(expected: string): void {
    if (!this.#peek(expected)) this.#fail(`Expected '${expected}'`);
    this.#position += 1;
  }

  #fail(message: string): never {
    throw new SyntaxError(`${this.#sourceName}:${this.#position}: ${message}`);
  }
}

function formatJsonPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((formatted, segment) => {
    return typeof segment === "number"
      ? `${formatted}[${segment}]`
      : `${formatted}[${JSON.stringify(segment)}]`;
  }, "$");
}
