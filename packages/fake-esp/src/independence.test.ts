import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

describe("fake ESP implementation boundary", () => {
  it("does not import controller, protocol, or domain behavior", () => {
    const violations: string[] = [];
    for (const path of productionSourceFiles()) {
      const source = readFileSync(path, "utf8");
      const importPattern =
        /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g;
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (
          specifier !== undefined &&
          specifier !== "mqtt" &&
          !specifier.startsWith("node:") &&
          !isLocalSourceImport(path, specifier)
        ) {
          violations.push(`${path}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains no production MQTT topic literal", () => {
    const violations = productionSourceFiles().filter((path) =>
      /(?<!test\/)aquarium\//.test(readFileSync(path, "utf8")),
    );
    expect(violations).toEqual([]);
  });
});

function productionSourceFiles(directory = sourceDirectory): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSourceFiles(path));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function isLocalSourceImport(path: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const relativeTarget = relative(
    sourceDirectory,
    resolve(dirname(path), specifier),
  );
  return (
    !isAbsolute(relativeTarget) &&
    relativeTarget !== ".." &&
    !relativeTarget.startsWith(`..${sep}`)
  );
}
