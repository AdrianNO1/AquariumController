import { statfs } from "node:fs/promises";

export interface BigIntFilesystemStatistics {
  readonly bavail: bigint;
  readonly bsize: bigint;
}

export interface BigIntStatfsPort {
  statfs(path: string): Promise<BigIntFilesystemStatistics>;
}

export interface FilesystemFreeSpacePort {
  readAvailableBytes(path: string): Promise<number>;
}

const nodeBigIntStatfs: BigIntStatfsPort = {
  async statfs(path) {
    const statistics = await statfs(path, { bigint: true });
    return { bavail: statistics.bavail, bsize: statistics.bsize };
  },
};

export class NodeFilesystemFreeSpace implements FilesystemFreeSpacePort {
  constructor(
    private readonly filesystem: BigIntStatfsPort = nodeBigIntStatfs,
  ) {}

  async readAvailableBytes(path: string): Promise<number> {
    if (path.trim().length === 0) {
      throw new TypeError("Filesystem measurement path must not be empty");
    }
    const statistics = await this.filesystem.statfs(path);
    if (
      typeof statistics.bavail !== "bigint" ||
      typeof statistics.bsize !== "bigint" ||
      statistics.bavail < 0n ||
      statistics.bsize <= 0n
    ) {
      throw new RangeError("statfs returned invalid block accounting");
    }
    const availableBytes = statistics.bavail * statistics.bsize;
    if (availableBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        "Available filesystem bytes exceed the safe integer range",
      );
    }
    return Number(availableBytes);
  }
}
