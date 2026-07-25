# Legacy production-input policy

Updated: 2026-07-25

## Scope

`.old/data` is intentionally ignored operator-local production input. Its
contents can change as the operator refreshes the aquarium snapshot, so they are
not a versioned development fixture, a Docker build input, or a CI dependency.
This document deliberately does not record expected file contents, counts, or a
fingerprint.

The importer never infers this path. Both analysis and commit require an
explicit `--source`, and commit additionally requires an explicit new
`--state-db`.

## Hermetic automated coverage

Migration tests create deterministic synthetic legacy JSON in temporary
directories. The synthetic set covers:

- strict UTF-8 JSON parsing and exact duplicate-key rejection;
- a representative valid import and deterministic report;
- missing legacy throttle defaults with explicit provenance;
- orphan-schedule preservation;
- skipped ephemeral and deferred files without executing their contents;
- only output-equivalent zero-boundary normalization;
- fatal schedule and reference errors;
- read-only dry-run behavior; and
- atomic commit, revision, outbox, and repeat-import protection.

CI therefore tests importer behavior without reading or embedding production
data. The clean Linux Docker verification after this isolation passed 95
files/618 unit tests and 81 files/557 critical tests. The preceding host run
reported 95 files/619 and 81 files/558; the one-test difference in each
selection is the intentional removal of environment-dependent `.old/data`
coverage.

Synthetic fixtures do not certify the aquarium snapshot.

## Production procedure

Use the exact release-image digest and the first-migration branch in
[the production deployment runbook](production-deployment.md):

1. Stop the legacy controller and prove it cannot publish MQTT commands.
2. Copy the actual legacy directory to a new immutable rollback location.
3. Reject symlinks and create and verify a deterministic SHA-256 inventory.
4. Run the importer in analysis mode against that read-only copy.
5. Preserve the full report and record its newly calculated source fingerprint,
   normalized counts, warnings, and errors.
6. Review every warning. Any error or unexplained transformation stops the
   migration.
7. Commit the same verified copy to a newly claimed `state.db`; never re-read a
   live or later-mutated source.
8. Keep the legacy installation and snapshot unchanged until the supervised
   cutover and soak have passed.

Do not compare the current production source against a fingerprint copied from
an earlier report. A different fingerprint means only that the source differs;
it requires a new human review rather than an automatic accept or reject.

## Fatal import policy

Abort the entire atomic import for:

- invalid UTF-8/JSON, exact duplicate keys, wrong core shapes, or ambiguous core
  fields;
- duplicate identities, unsafe mapping prefixes, invalid pins, or mappings to
  missing channels;
- unknown schedule types, malformed/nonfinite/out-of-range points, reversed or
  zero-duration segments, gaps, overlaps, discontinuities, or unsafe tails;
- invalid throttles;
- a case collision without demonstrably case-sensitive target behavior; or
- any transformation that could change actuator output without an explicit
  reviewed policy.

The analyzer reports all discoverable issues in one dry-run. It does not
silently repair, discard, merge, extend, clamp, or rename control data.
