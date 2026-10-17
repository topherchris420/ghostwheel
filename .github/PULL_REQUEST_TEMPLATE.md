## What changes, and why?

Describe the user-visible or research outcome and any changed assumptions.

## Reproduction and verification

- [ ] Added/updated a regression test where applicable
- [ ] `npm run format:check` / `npm run verify:browser` / `npm run verify:workspace` / `npm run build`
- [ ] `PYTHONPATH=backend python -m unittest discover -s tests -v`
- [ ] `python scripts/release_gate.py` (source release check)
- [ ] Relevant ROS 2 observer tests if those files changed
- [ ] Not run (explain below)

**Evidence:** Seed/scenario, expected/actual verdict, and sanitized traces or reproducible commands.

**Limits:** What was not tested (CARLA server, Windows installer, real hardware, etc.)?

## Safety and distribution

- [ ] Simulation actuation remains simulation-only; any real vehicle connections remain passive
- [ ] No secrets, proprietary OEM data, unlicensed material or personal records added
- [ ] No unsupported safety/certification claims
- [ ] Any release artifact is unsigned unless independently verified otherwise