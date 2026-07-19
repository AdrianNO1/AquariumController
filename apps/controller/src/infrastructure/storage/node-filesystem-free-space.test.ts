import { describe, expect, it } from "vitest";

import {
  NodeFilesystemFreeSpace,
  type BigIntStatfsPort,
} from "./node-filesystem-free-space.js";

class StubStatfs implements BigIntStatfsPort {
  path: string | null = null;

  constructor(
    private readonly result: {
      readonly bavail: bigint;
      readonly bsize: bigint;
    },
  ) {}

  async statfs(path: string): Promise<{
    readonly bavail: bigint;
    readonly bsize: bigint;
  }> {
    this.path = path;
    return this.result;
  }
}

describe("NodeFilesystemFreeSpace", () => {
  it("uses available blocks and converts an exact bigint product", async () => {
    const filesystem = new StubStatfs({ bavail: 3n, bsize: 4_096n });
    const reader = new NodeFilesystemFreeSpace(filesystem);

    await expect(reader.readAvailableBytes("C:\\storage")).resolves.toBe(
      12_288,
    );
    expect(filesystem.path).toBe("C:\\storage");
  });

  it("rejects overflow and invalid block accounting", async () => {
    await expect(
      new NodeFilesystemFreeSpace(
        new StubStatfs({
          bavail: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          bsize: 1n,
        }),
      ).readAvailableBytes("C:\\storage"),
    ).rejects.toThrow(/safe integer range/u);

    await expect(
      new NodeFilesystemFreeSpace(
        new StubStatfs({ bavail: -1n, bsize: 4_096n }),
      ).readAvailableBytes("C:\\storage"),
    ).rejects.toThrow(/invalid block accounting/u);
    await expect(
      new NodeFilesystemFreeSpace(
        new StubStatfs({ bavail: 1n, bsize: 0n }),
      ).readAvailableBytes("C:\\storage"),
    ).rejects.toThrow(/invalid block accounting/u);
  });

  it("propagates statfs errors and rejects an empty path", async () => {
    const statfsError = new Error("statfs failed");
    const filesystem: BigIntStatfsPort = {
      async statfs() {
        throw statfsError;
      },
    };
    const reader = new NodeFilesystemFreeSpace(filesystem);

    await expect(reader.readAvailableBytes("C:\\storage")).rejects.toBe(
      statfsError,
    );
    await expect(reader.readAvailableBytes("  ")).rejects.toThrow(
      /must not be empty/u,
    );
  });
});
