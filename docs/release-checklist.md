# Public release readiness: go/no-go

GHOSTWHEEL is currently a research simulator. This checklist prepares for publication; it **does not** change repository visibility or publish a GitHub release.

## 1. Source and reproducibility

- [ ] Decide the release version and update `package.json`, `package-lock.json`, and `src-tauri/tauri.conf.json` **together**.
- [ ] Run `python scripts/release_gate.py`; ensure all source preflight checks pass.
- [ ] Run `npm ci`, `npm run format:check`, `npm run verify:browser`, `npm run verify:workspace`, and `npm run build` on a clean checkout.
- [ ] Run `PYTHONPATH=backend python -m unittest discover -s tests -v` and inspect failed/skip counts.
- [ ] Review model limitations, README/demo links, dependencies, bundled third-party notices and the [contribution](../CONTRIBUTING.md) and [security](../SECURITY.md) policies.
- [ ] Confirm no tokens, private evidence, personally identifying recordings, real vehicle credentials, or unauthorized third-party assets are tracked.

## 2. Actual CI execution

- [ ] **GitHub Actions has allocated runners, executed steps, and completed successfully.** A run showing zero runner time/zero steps is blocked, not passing. Check GitHub billing, Actions permissions, or GitHub Support separately if jobs cannot start.
- [ ] Browser/Python checks are green and no safety validation was disabled to obtain green badges.
- [ ] Relevant ROS 2 C++ observer contract tests pass; physical command transmit and enable-service prohibitions remain enforced. Installing native ROS/vendor libraries does **not** certify hardware safety.

## 3. Windows packaging (supported target only)

- [ ] Build on Windows x64 with Node 22, Python 3.11 x64, Rust MSVC, required C++ tools, and the pinned build requirements.
- [ ] Run `npm run desktop:build`; run the frozen-sidecar, portable native UI, silent-install and installed native UI smoke tests on that same build.
- [ ] Run `python scripts/desktop-final-verify.py` and `python scripts/release_gate.py --artifacts` before distributing the artifacts. A stale or absent QA receipt **blocks** release.
- [ ] Keep the installer, portable ZIP, `SHA256SUMS`, `build-receipt.json`, and verification receipts together. Compare installer and ZIP hashes with the manifest after download.
- [ ] Label unsigned builds explicitly and warn that Windows SmartScreen can present a publisher warning. Do **not** imply code signing or automotive safety certification.
- [ ] Confirm a clean installer and uninstaller experience on a disposable Windows VM, including WebView2 prerequisites. CI silent-install coverage does not substitute for end-user acceptance testing.

## 4. Publish only after explicit approval

- [ ] Independently review the release candidate, supported platforms and known limitations; label unsupported CARLA-server and real-hardware claims clearly.
- [ ] Deliberately decide whether to make the private repository public; confirm source licensing and remove sensitive/unlicensed files **before** changing visibility.
- [ ] Publish a GitHub release only after approval, attaching verified artifacts and hashes. Record the exact commit SHA, tag, build workflow run, outstanding risks, and whether the binary is signed.

**Fail closed:** failing checks, unallocated runners, missing receipts, modified binaries, unsigned-status misrepresentation or unsafe physical-actuation changes are release blockers, not exemptions.