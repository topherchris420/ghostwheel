# Security policy

## Scope

GHOSTWHEEL is a research simulator with a browser UI, optional local desktop backend, exported evidence, and an **observation-only** ROS 2 package. It is not a real-vehicle control system, safety monitor, penetration-testing appliance, or product approved for road use.

Security-sensitive areas include the desktop loopback authorization token, exposed network ports, simulation-only connector allowlist, validation of user input, exported evidence integrity, dependency and installer supply chains, and the ROS 2 boundary prohibiting physical actuation.

## Reporting a vulnerability

**Do not publish an exploitable issue or private token in a public GitHub issue.** Use GitHub's private vulnerability reporting through this repository's **Security → Advisories → Report a vulnerability** interface if available. If the private reporting interface is not enabled, contact the repository owner privately through an existing trusted channel. Do not assume a public discussion is confidential.

Include an affected commit/version, reproduction instructions against the simulator or an isolated mock, impact, any available logs with secrets removed, and a proposed mitigation if known. Avoid testing against vehicles, public networks, or systems you do not control or have explicit authorization to test.

There is no promised response SLA or security certification. Until a release is verified and approved, treat all binaries and integrations as experimental. Never interpret a simulated safe stop or software advisory as a real-world safety guarantee.