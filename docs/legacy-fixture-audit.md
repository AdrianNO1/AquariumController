# Legacy development fixture audit

Updated: 2026-07-10

Scope: `.old/data` only. These files are imperfect development fixtures, not production data. Seven UTF-8 JSON files parse without a BOM or exact duplicate object keys. The migration dry-run must reproduce this report from code; this document is not a substitute for validation.

## Import disposition

| File                             | Shape / count                                           | Disposition                                                                                                    |
| -------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `links.json`                     | 53 channels, 160 schedule segments, seven control types | Core schedule/channel import; currently contains fatal graph defects                                           |
| `channels.json`                  | Nine prefix profiles, eight nonempty, 40 pin mappings   | Core output/mapping import; empty profile is reported and skipped; eight missing schedule references are fatal |
| `throttle.json`                  | Five per-type throttle values                           | Core throttle import; missing legacy defaults are materialized only with an explicit warning                   |
| `temporaryoverwritesliders.json` | Six values with a 2025 timestamp                        | Expired ephemeral actuator state; checksum/count recorded, never imported as active override                   |
| `device_memory.json`             | Two experimental runtime entries                        | Unreferenced runtime/WIP state; checksum/count recorded and skipped                                            |
| `espstatuses.json`               | Experimental switch/sensor/DSL status snapshot          | Stale WIP runtime state; checksum/count recorded and skipped                                                   |
| `homepagedata.json`              | Sketch5 codegroups, switches, timers and sensors        | Explicitly deferred WIP file; checksum/count and detailed warning, no DSL execution or active import           |

## Fatal findings in the current fixtures

The expected dry-run result is `valid: false`, `canCommit: false` with at least 35 fatal findings:

- Three zero-duration first segments: `Royal Blue`, `Pump 1`, and `Pump 2` at minute 0.
- Twenty-four schedules end at minute 274 rather than 1439: all six `Test ...`, lowercase `bad ...`, uppercase `Bad ...`, and `Biljard ...` channels.
- Eight pin mappings reference schedules that do not exist: `Loft Violet`, `Loft Royal Blue`, `Loft Blue`, `Loft White`, `Qt3 Violet`, `Qt3 Royal Blue`, `Qt3 Blue`, and `Qt3 White`.

No state rows may be committed while any fatal issue remains.

## Warnings that preserve data explicitly

- `channels.json` has an empty prefix with zero rows. Report and skip it; never insert an empty matching prefix.
- Six case-only channel pairs exist (`bad ...` and `Bad ...`). Preserve both under verified SQLite `BINARY` identity and report the collision; never case-fold or merge them.
- Throttles are absent for `bad`, `loft`, `biljard`, `qt2`, `qt3`, and `qt4`. The running compiler defaults missing values to 100. An import may materialize 100 only with provenance `legacy-default` in the report.
- Thirty-one schedules are currently unmapped. Preserve and report them; an unused schedule is not data loss or a fatal referential error.
- Twenty-four canonical route channels are missing, including every `loft`, `qt2`, `qt3`, and `qt4` channel. Missing but unmapped channels are warnings and are never silently invented.
- Legacy `x/y` graph coordinates are redundant presentation data. Recompute them from authoritative minute/percentage values; report discarded coordinates, including inconsistent `Pump 4` endpoints.
- Ephemeral/WIP files are skipped with file hash, row counts, reason, and importer version so the omission is auditable.

## Fatal policy for any source directory

Abort the entire atomic import for:

- Invalid UTF-8/JSON, exact duplicate JSON keys, wrong core root/record shape, or ambiguous unknown core fields.
- Duplicate normalized identities; an empty mapping prefix with rows; overlapping nonempty prefixes; duplicate pin/channel within a profile; invalid pins; mapping references to missing channels.
- Unknown schedule type, empty links, malformed points, noninteger/out-of-range times, nonfinite/out-of-range percentages, reversed/zero-duration segments, start other than 0, end other than 1439, gaps, overlaps, adjacent discontinuities, or wrap mismatch.
- Nonnumeric/out-of-range throttles.
- A case collision when the target database/query path is not demonstrably case-sensitive.
- Any transformation that could change actuator output without an explicit operator-approved policy.

The tool must report every discoverable issue in one dry-run rather than stopping at the first error. It may not repair, discard, merge, extend, clamp, or rename control data silently.
