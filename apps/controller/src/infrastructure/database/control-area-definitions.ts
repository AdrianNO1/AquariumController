import type { ControlArea } from "@aquarium/contracts";

export const CONTROL_AREA_DEFINITIONS = [
  { slug: "lights", typeKey: "light", label: "Lights" },
  { slug: "pumps", typeKey: "pump", label: "Pumps" },
  { slug: "testlights", typeKey: "testlight", label: "Test lights" },
  { slug: "bad", typeKey: "bad", label: "Bad" },
  { slug: "loft", typeKey: "loft", label: "Loft" },
  { slug: "biljard", typeKey: "biljard", label: "Biljard" },
  { slug: "frag", typeKey: "frag", label: "Frag tank" },
  { slug: "qt1", typeKey: "qt1", label: "Quarantine 1" },
  { slug: "qt2", typeKey: "qt2", label: "Quarantine 2" },
  { slug: "qt3", typeKey: "qt3", label: "Quarantine 3" },
  { slug: "qt4", typeKey: "qt4", label: "Quarantine 4" },
] as const satisfies readonly ControlArea[];
