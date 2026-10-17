# Contributing to GHOSTWHEEL

GHOSTWHEEL is a **simulation-first automotive cybersecurity research tool**. Contributions should make its simulated decisions easier to understand, reproduce, inspect, and falsify. Do not add vehicle actuation, CAN command transmitters, DBW enable operations, or uncontrolled remote access.

## Reproduce before proposing

Use Node.js 22 and Python 3.11+. From a clean clone:

```sh
npm ci
npm run format:check
npm run verify:browser
npm run verify:workspace
npm run build
PYTHONPATH=backend python -m unittest discover -s tests -v
python scripts/release_gate.py
```

On PowerShell, set `$env:PYTHONPATH = (Join-Path $PWD 'backend')` before the Python test command. For ROS 2 observer work, also run the dependency-free C++ contract tests in the respective GitHub workflows or a compatible Autoware workspace. A GitHub Actions status that failed **before runner allocation** is not a completed test and must not be represented as a passing run.

## A useful bug report or PR includes

- Reproduction steps, operating system, Node/Python versions and browser or Windows build details.
- The selected fictional vehicle, seed, and exact scenario/command and expected versus actual response.
- Sanitized evidence JSON or a minimal test, with passwords, tokens, vehicle identifiers and personal data removed.
- A statement of what was tested locally and what remains untested (especially real CARLA servers or ROS/hardware).

Prefer tests that prove *both* valid and rejected control paths, out-of-order events, stale messages, invalid numeric values, tampered evidence and failed authorization. Regression fixes should add a test that fails before the fix and passes afterward.

## Research and scope

Document the assumptions and limits of any new synthetic model; do not describe fictional CAN frames or ECU behavior as real OEM traffic. The passive ROS 2 observer is **not** a safety-rated vehicle controller. No real steering, throttle, brake, DBW enable, or physical emergency-stop commands belong in this project. See [SECURITY.md](SECURITY.md) for confidential reporting and [docs/release-checklist.md](docs/release-checklist.md) before packaging.

Maintainers review contributions for reproducibility, provenance, licensing, and adherence to the simulation-only boundary. Contributions are offered under the repository's MIT license unless clearly identified as separately licensed material.