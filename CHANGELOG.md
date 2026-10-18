# Changelog

Changes for release candidates are tracked here. A repository commit, successful web preview, or uploaded CI artifact is **not** a published, supported release.

## Unreleased

- Added a focused Operations view with driving controls beside the live field and optional technical instruments; the view preference is saved on-device.
- Added Finish drive & review, which stops driving controls and pauses the live simulation before opening replay.
- Kept walkthrough inspection progress after leaving replay, scoped scenario progress to its run, and added visible pause/reset recovery actions.
- Clarified Save recording versus Export verification ledger and corrected the browser retention guidance.
- Extended interface integration coverage for view preferences, paused replay, walkthrough progress, and recovery.

- Added a repeatable release gate for source/version consistency, MSVC artifact integrity, and complete native/installer QA evidence.
- Added adversarial regression tests for altered installers, mutated portable ZIPs, unverified native smoke, and mismatched source versions.
- Promoted Windows native/UI/install smoke and final artifact verification into the Windows workflow, before any artifact upload.
- Added contribution, private vulnerability reporting, and public-release criteria.

## 0.1.0 — research preview (not independently release-certified)

- Synthetic ASTER, VECTOR and NOMAD vehicle experiments with command validation and event/replay evidence.
- Browser simulator and optional unsigned Windows packaging recipe; conditional passive ROS 2 integrations.
- CARLA client integration is optional; a live CARLA server has not been independently verified by the normal CI path.

This changelog does not imply that a public GitHub release or signed installer exists.