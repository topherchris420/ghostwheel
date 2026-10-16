# University demonstration - five minutes

## Before the room opens

Install GHOSTWHEEL, launch it once, and check the local-model status. A GPU simulator is unnecessary for the built-in demonstration. Keep the PDF report and `output/experiments/seed-42/results.json` as evidence. If demonstrating CARLA, use a separately verified matching 0.9.16 server and an empty world; it is not part of the validated live presentation below.

## 0:00-0:40 - establish the claim

"This is an original simulator-only automotive cybersecurity experiment. We studied OVMS interfaces and CARLA documentation, and used REA to inventory an official OVMS client package. We did not recover VSEP software, decompile OVMS firmware, or test a production car."

Show Protocol: the gateway separates requested controls from simulator actuation, and the displayed CAN frames are synthetic. The restriction label is an aesthetic.

## 0:40-1:40 - drive the independent models

Reset ASTER with seed 42, arm control, hold W briefly and gently steer with A/D. Show requested and modeled angle and the path. Press Space to stop. Switch to VECTOR and repeat; its dual modeled steering channels have different configured dynamics. The wheelbase and lag are invented parameters, not measured OEM properties.

## 1:40-2:40 - reject a synthetic input

Choose Replay and run it. Explain the accepted initialization and repeated sequence number. Show `replayed_sequence`, zero throttle, neutral target and safe-state indication. Repeat Stale or Range. Explain why rejecting a bad command and moving to a safe state must be checked separately. Dropout demonstrates the command lease at 350 ms, not a network exploit.

## 2:40-3:50 - reproduce the experiment

Run the Research suite with seed 42. Explain the denominator: 24 rejected invalid commands (eight for each of three models), plus three independent watchdog stops. Read the actual tracking RMSE and elapsed local gateway times. Show failed assertion count and export JSON. There is no basis for a statement of universal cyberattack resilience.

## 3:50-4:40 - forensic replay

Load a recorded interactive run, verify the chain and builtin recomputation, scrub and play. Emphasize that this is read-only playback. Explain that the hash chain exposes partial corruption relative to the saved anchor; a local administrator could rewrite the whole record and anchor.

## 4:40-5:00 - close with the limitations

"The measured findings describe this software and these finite synthetic scenarios. The CARLA adapter has contract tests; a real CARLA server driving run was not validated during this build. There is no real-car actuation connector. Next research steps are an independently validated CARLA run, stronger hardware-in-the-loop modeling and external signing of evidence."

Use the technical report for questions about equations, threat model, evidence provenance, timing endpoints and source references.
