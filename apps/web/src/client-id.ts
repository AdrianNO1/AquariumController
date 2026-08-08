export function createClientId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));

  return `${prefix}-${hex.slice(0, 4).join("")}-${hex
    .slice(4, 6)
    .join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10).join("")}`;
}
