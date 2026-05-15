# Corpus shards — per-host attestations

Each launch-corpus shard is generated on one CPU host and finalized
independently. The shards are then merged into the canonical launch
corpus, whose `corpusRoot` enters the signed bundle manifest.

This directory holds **manifests only** — the raw NDJSON and finalized
JSON snapshots are multi-gigabyte artifacts that live under
`/var/lib/coretex/` on the merge host and are not tracked in git.

Each manifest is the canonical, signable attestation of a shard's
contribution to the launch corpus. It binds:

- the producer host (label + hardware description)
- the per-shard `corpusRoot`
- exact event/split/family counts
- per-file SHA-256 and byte counts
- pinned model revisions (bi-encoder + labeling)
- cross-system reproducibility evidence (sorted-sha256 vs another host
  and a pointer to the proof doc)

A shard's producer instance may be decommissioned once its manifest is
committed; the manifest is the audit trail. See the `archive` field for
the verified destination host and transfer method.

The merge step (task #14) consumes these manifests plus their referenced
NDJSON files, validates each file against its declared SHA-256, and
produces the canonical launch-corpus `corpusRoot`. Until that step
completes the per-shard corpusRoots are pre-merge attestations only.
