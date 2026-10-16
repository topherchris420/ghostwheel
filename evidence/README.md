# Evidence directory

This directory contains research inputs and retained observations. None of the downloaded OVMS files is part of GW-01's runtime, and none was executed, installed or flashed.

- `source-ledger.json`: primary URLs, retrieval date, pinned source revision, SHA-256 values, claims and limits.
- `rea-summary.json`: selected provider availability and completed archive inventory observations.
- `rea-ovms-package.json`: full REA 6.4.0 evidence bundle (2 records).
- `source-snapshots/`: four OVMS interface headers at commit `4bb334a59bf3bee8208f579add8b242fa01c1a5c`, plus upstream MIT license.
- `artifacts/`: public firmware and client APK research inputs.
- `upstream-ovms3/`: sparse source checkout used by the investigation; the portable header snapshots are sufficient for the documented interface observations.

Read [research-foundations.md](../docs/research-foundations.md) before citing a result. Static archive inventory is not decompilation, and a provider error is not a firmware finding.

## Reproduction

1. Read each public URL and retrieval/version field in `source-ledger.json`. Mutable URLs may have changed since 2026-10-16; retain the observed digest rather than assuming a later download is the same file.
2. Verify local inputs with PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 evidence\artifacts\ovms3-main.bin
Get-FileHash -Algorithm SHA256 evidence\artifacts\OpenVehicleApp-release-5.2.4.apk
Get-FileHash -Algorithm SHA256 evidence\source-snapshots\*.h
```

3. For source interfaces, use the commit-qualified URLs from the ledger. They identify exactly the reviewed revision without requiring the sparse checkout.
4. For the supported REA package workflow, call the connected REA 6.4.0 MCP tools using absolute local paths:

```json
{"tool":"open_binary","arguments":{"path":"C:\\absolute\\path\\OpenVehicleApp-release-5.2.4.apk"}}
{"tool":"inspect_artifact","arguments":{}}
{"tool":"export_evidence_bundle","arguments":{"path":"C:\\absolute\\new-output\\rea-ovms-package.json"}}
{"tool":"close_binary","arguments":{}}
```

Archive content identity is expected to match for matching input bytes. Evidence IDs also depend on recorded parameters and environment; do not assume IDs generated on another host must match.

Firmware inspection was attempted with `inspect_firmware_regions` and the downloaded firmware's absolute path. It returned `capability_unavailable` on Windows ARM64. A subsequent Linux analysis needs a caller-supplied supported Binwalk engine and must produce a new, separately labeled evidence record. This investigation did not install one.

Do not include downloaded binaries, the sparse checkout or its Git metadata in the application installer. Include this ledger, the compact summary, source snapshots/license and the research report in the research handoff; the full bundle can be delivered separately.

