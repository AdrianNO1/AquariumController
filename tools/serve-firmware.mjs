import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const [artifactPath, portText = "8766"] = process.argv.slice(2);
if (artifactPath === undefined) {
  throw new Error("Usage: node tools/serve-firmware.mjs <artifact> [port]");
}
const port = Number.parseInt(portText, 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError("Port must be an integer from 1 through 65535");
}

const artifact = await readFile(artifactPath);
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/firmware.bin") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": artifact.length,
    "Cache-Control": "no-store",
  });
  response.end(artifact);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Serving ${artifact.length} bytes on port ${port}`);
});
