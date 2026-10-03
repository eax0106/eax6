# Registry package scans and first-version review

D21 selects OSV-Scanner for known dependency advisories, with staff review of
each tool's first published version. Socket remains deferred until outside
publishers can publish. A clean OSV result is dependency evidence; staff still
inspect the package, declared capabilities and permissions.

The production `RegistryModule` uses `OsvPackageScanProvider` and
`S3PackageArtifactReader`. The shared scanner port keeps the existing report
shape. Mock scanners are test fixtures; production has no mock fallback.

## Artifact and executable configuration

- `REGISTRY_SCAN_PROVIDER` is `osv` (the default and only production option).
- `REGISTRY_PACKAGE_BUCKET` names the registry artifact bucket.
- `OSV_SCANNER_EXECUTABLE` defaults to `osv-scanner` on the executable path.
- `AWS_REGION` selects the object-store region through the existing AWS setup.
- The Node image builds OSV-Scanner **v2.6.0**, without CGO, and includes it at
  `/usr/local/bin/osv-scanner`. Local verification uses that same version.

Store an immutable version of the package at:

```text
s3://<bucket>/<tenantId>/registry/<manifestId>/<manifestVersion>/<filename>?versionId=<object-version>
```

The bucket must support versioned objects; the service identity needs permission
to read that exact object version. A missing bucket, unpinned reference,
foreign prefix, wrong returned object version, unavailable executable or lookup
failure produces a nonclean outcome. There is no historical-average or sandbox
fallback. The report records the actual executable version and artifact SHA-256.

Accepted inputs are a supported lockfile, a POSIX ustar archive containing
lockfiles, or a gzip-compressed ustar archive. Supported basenames are
`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`,
`requirements.txt`, `Pipfile.lock`, `poetry.lock`, `pdm.lock`, `pylock.toml` and
`uv.lock`. Dependencies must be pinned in a format OSV understands. npm manifests
must yield npm dependencies; pip manifests must yield PyPI dependencies; MCP
packages can yield either ecosystem.

The reader caps compressed input at 10 MiB. Extraction caps expanded input at
50 MiB and 1,000 archive entries. Traversal, links, duplicate paths, damaged
headers and unsupported extended tar entries are refused. ZIP/wheel archives
are not supported. Unsupported or empty inputs stay unscanned and unpublished;
renaming them does not turn them into clean packages.

Only lockfiles enter a fresh temporary directory. Package code and package
scanner configuration are ignored. The executable receives an empty explicit
configuration, no service credentials, no package resolution and no call
analysis. It runs directly, with a 120-second deadline and 8 MiB output cap.
Temporary files and object streams are closed on success and failure. No
package install script runs.

## Publication and staff decisions

The existing tenant editor/admin scan route locks the owned manifest and
version before scanning. A concurrent scan conflicts. Report storage, latest
report pointer and publication state are committed together after the scan.

- A tool without a recorded first-version approval moves from a complete clean
  scan to `review_pending`; it remains private in the catalogue.
- Staff admin/security roles inspect the first version in **Marketplace
  Moderation → First tool version review**. The queue shows the immutable
  artifact reference, capabilities, permissions and exact report.
- Approval and rejection both require a reason. Staff identity comes from the
  authenticated staff session. The decision names the current scan report;
  a replaced report conflicts and requires reload.
- Approval records staff, time, reason and report and publishes the version.
  Rejection records the decision and leaves it `scan_failed`. A new scan can
  subsequently be reviewed.
- Once a clean first version has a recorded approval, later versions still need
  a complete clean scan. Any advisory, including low or unknown severity,
  prevents publication. Errors and empty dependency results prevent it too.
- Identical concurrent staff retries return the same recorded decision and
  send one audit request. A different decision, actor or reason conflicts.
  Audit failure rolls the decision/publication transaction back. Audit delivery
  is a separate service call; no distributed transaction is claimed.
- Revocation and staff takedown serialize on the manifest lock. A late scan
  completion cannot republish the withdrawn version. The generic governance
  approve action cannot substitute for first-version review.

OSV severity comes from reported numeric group severity. Advisory identity and
package/version locator remain in each finding. Missing severity is shown as
`info` with an explicit missing-severity explanation; it still prevents
publication. See the official [OSV output documentation](https://google.github.io/osv-scanner/output/)
and [supported lockfiles](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/).

Migration `0007_tool_version_review.sql` adds exact version/report references
and attributed review fields. Existing published versions without a recorded
staff decision are held for review if clean, or returned to scan failure.
No legacy approval is invented. Its rollback removes the new fields and moves
pending versions to draft; it does not automatically republish packages.
Deferred report-reference constraints allow report/version/manifest deletion
in one transaction while still rejecting references to another version's scan.

## Verification

Committed suites cover real ordinary PostgreSQL, public Fastify staff
middleware/RBAC, scan and review races, current-report conflicts, audit failure,
revocation, migration upgrade/rollback and rendered live/mock review behavior.
`platform-api:test-db-integration` explicitly includes the staff-review native
suite. The OSV adapter's real-executable cases run when
`OSV_SCANNER_EXECUTABLE` is supplied; local acceptance supplies the pinned real
binary and asserts those cases did not skip. Other CI scanner tests cover strict
result handling, bounded extraction, object scope and process isolation without
requiring a live OSV lookup.

Private `.unlazy` acceptance scripts run local proofs and restored mutation
controls; they are excluded from Docker build contexts and are not CI scripts.
