# Manual CLI releases

`for-bgo.yml` has one six-platform build matrix. Push builds only upload artifacts.
Publishing requires a manual dispatch with `is_release=true` from `for-bgo` in
`kira1928/biliLive-tools`, a new tag, and all six successful builds. There is no
replacement option. Input validation and all API reads fail closed.
Release notes identify the CLI version from `packages/CLI/package.json` and the
required Node.js runtime from `.node-version` in the checked-out source. Both
values are format-validated before any remote mutation; dispatch text cannot
override them.

## Artifact contract

Each `bgo-release-<os>-<arch>` artifact contains exactly:

- `bililive-cli-lib-<os>-<arch>.zip`, with CLI files at the archive root.
- `manifest.json`, recording source commit/tree, repository, workflow run,
  producing attempt, platform, filename, size, and SHA-256.

Python 3.12 standard-library ZIP packaging runs on each host after native smoke
checks. ARMv7 builds and checks still run inside emulation; only archiving runs
on the host. Dotfiles and executable modes are preserved. Symlinks and special
files are rejected rather than followed. No dependency install is needed in the
write-privileged publisher.

This replaces the previous raw-lib CI artifact layout. Do not apply the old
one-time raw-artifact repacker to these bundles. `validate_bundle`, `fetch_artifacts`,
and `publish` are importable for a separately reviewed fixed-source wrapper.
`publish` accepts an internal validation callback; the manual CLI always uses
its own dispatch/run/attempt checks and exposes no input to replace them.

## Partial reruns

Successful platforms retain their artifact when failed jobs are rerun. Every
rebuilt platform creates a fresh ZIP and manifest before uploading with
`overwrite: true`; that replaces a CI artifact within this run only. It never
replaces a Release asset. Before publishing, the latest known result for every
platform must be successful at the exact SHA/run, and exactly six current
artifacts must pass their immutable artifact-ID/digest and manifest checks.
GitHub may clone earlier successful jobs into a later attempt with old execution
timestamps. Producing manifest attempts may therefore precede the latest run
attempt. A failed newer build blocks publication despite any surviving artifact.

The current workflow is still running while its publisher executes. Its run
must be in progress with no conclusion; the six build jobs, not the overall
run, must have completed successfully. The source is the dispatch SHA, not a
later branch head. A later branch push does not change that selected source.

## Failure and recovery

The publisher refuses any existing tag, release, or draft. After verifying all
six archives, it creates a new tag and draft, uploads six assets, checks the
remote names, sizes, upload states and SHA-256 digests, then makes one publication
request. Missing server asset digests fail closed. It checks the result again.

This is not a GitHub cross-resource transaction and promises no rollback. A
failure can leave this run's new tag or draft, or an uncertain publication
outcome. Existing releases are never moved, edited, purged, or deleted.
Mutation requests are never retried automatically. Inspect the run log's tag
and draft ID, remote tag target, release visibility, and assets before acting.
Do not blindly rerun, delete a tag, or replace a release. If published, verify
it; if incomplete, review any cleanup separately or choose a new release tag.
The workflow never performs cleanup itself.

Publishers are serialized with `cancel-in-progress: false`. GitHub concurrency
is not a lock against humans or unrelated workflows, and pending execution
order is not guaranteed. Old workflow revisions retain their old behavior:
never dispatch or rerun the historical destructive release workflow.

## Returning to an older version

`force_replace` has been removed. To return to an older release, use its existing
tag and unchanged assets, and pin the consuming tool configuration to that
version. This does not require rebuilding or republishing the old release.

If rebuilding older source or correcting an already published version is
necessary, retain this safe release workflow, validate all six platform builds,
and publish under a new, unused version tag. Never move an existing tag, replace
its assets, or dispatch a historical revision of the destructive workflow.

## Local checks

Run `python -m unittest discover -s scripts -p test_bgo_release.py -v`.
All GitHub operations in this test suite are mocked. The suite also runs in each
matrix job. Local tests do not establish that hosted runners are available or
that a real tag/upload/publication has succeeded.
