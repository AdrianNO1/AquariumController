const channelColorCandidates = [
  "#6c54d8",
  "#a84aa7",
  "#315bd6",
  "#0aa0c0",
  "#87959e",
  "#db5451",
  "#2aa79f",
  "#d78c2d",
  "#53a85f",
  "#b45f91",
  "#4d83bd",
  "#9866d5",
] as const;

export function chooseDistinctChannelColor(
  existingColors: readonly string[],
): string {
  if (existingColors.length === 0) return channelColorCandidates[0];
  const existing = existingColors.map(hexToRgb);
  return channelColorCandidates.reduce<{ color: string; distance: number }>(
    (best, candidate) => {
      const candidateRgb = hexToRgb(candidate);
      const nearest = Math.min(
        ...existing.map((color) => colorDistance(candidateRgb, color)),
      );
      return nearest > best.distance
        ? { color: candidate, distance: nearest }
        : best;
    },
    { color: channelColorCandidates[0], distance: -1 },
  ).color;
}

function hexToRgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function colorDistance(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}
