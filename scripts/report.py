"""Build the GW-01 technical report from retained experiment and research evidence."""
from pathlib import Path
import json
import math
import sqlite3
import sys
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether, Image as FlowImage
from reportlab.graphics.shapes import Drawing, Rect, Line, String, PolyLine, Polygon

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf/GHOSTWHEEL-GW01-Technical-Report.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
RESULT = json.loads((ROOT / 'output/experiments/seed-42/results.json').read_text(encoding='utf-8-sig'))
VERIFY = json.loads((ROOT / 'output/verification/verification.json').read_text(encoding='utf-8-sig'))
LEDGER = json.loads((ROOT / 'evidence/source-ledger.json').read_text(encoding='utf-8-sig'))
REA = json.loads((ROOT / 'evidence/rea-summary.json').read_text(encoding='utf-8-sig'))
INK = colors.HexColor('#14282c')
AMBER = colors.HexColor('#a75d17')
CYAN = colors.HexColor('#157a83')
LIGHT = colors.HexColor('#eaf1f1')
MUTED = colors.HexColor('#506368')
STYLES = getSampleStyleSheet()
STYLES.add(ParagraphStyle(name='BodyGW', fontName='Helvetica', fontSize=9.5, leading=14.2, textColor=INK, spaceAfter=9))
STYLES.add(ParagraphStyle(name='SmallGW', fontName='Helvetica', fontSize=8, leading=11.5, textColor=MUTED, spaceAfter=6))
STYLES.add(ParagraphStyle(name='H1GW', fontName='Helvetica-Bold', fontSize=23, leading=28, textColor=INK, spaceAfter=19))
STYLES.add(ParagraphStyle(name='H2GW', fontName='Helvetica-Bold', fontSize=12, leading=16, textColor=CYAN, spaceBefore=10, spaceAfter=8))
STYLES.add(ParagraphStyle(name='CellGW', fontName='Helvetica', fontSize=8.2, leading=11.4, textColor=INK))
STYLES.add(ParagraphStyle(name='CodeGW', fontName='Courier', fontSize=7.7, leading=11.3, textColor=INK, backColor=LIGHT, borderPadding=9, spaceAfter=11))
STORY=[]


def clean(text):
    return str(text).replace('\u2014',' - ').replace('\u2013','-').replace('\u2011','-').replace('\u2019',"'").replace('\u201c','"').replace('\u201d','"').replace('\u2192',' -> ')


def p(text, style='BodyGW'):
    STORY.append(Paragraph(clean(text), STYLES[style]))


def title(number, text):
    p(f'GW-01 / TECHNICAL RESEARCH REPORT / {number:02}', 'SmallGW')
    p(text, 'H1GW')


def h(text): p(text, 'H2GW')
def page(): STORY.append(PageBreak())

def table(rows, widths, header=True):
    prepared = [[Paragraph(escape(clean(cell)), STYLES['CellGW']) for cell in row] for row in rows]
    t=Table(prepared, colWidths=widths, hAlign='LEFT', repeatRows=1 if header else 0)
    commands=[('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),('LINEBELOW',(0,0),(-1,0),1,CYAN),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,LIGHT])]
    if header: commands.append(('BACKGROUND',(0,0),(-1,0),colors.HexColor('#d8e8e8')))
    t.setStyle(TableStyle(commands)); STORY.append(t); STORY.append(Spacer(1,9))


def footer(canvas, doc):
    canvas.saveState(); w,h=doc.pagesize
    canvas.setFillColor(INK); canvas.rect(0,h-35,w,35,fill=1,stroke=0)
    canvas.setFont('Helvetica-Bold',8); canvas.setFillColor(colors.white)
    canvas.drawString(45,h-22,'GHOSTWHEEL  /  GW-01')
    canvas.setFillColor(colors.HexColor('#e0ad73')); canvas.setFont('Helvetica',7.5)
    canvas.drawRightString(w-45,h-22,'RESTRICTED AESTHETIC  |  SIMULATION RESEARCH')
    canvas.setStrokeColor(colors.HexColor('#b4c6c9')); canvas.line(45,37,w-45,37)
    canvas.setFillColor(MUTED); canvas.setFont('Helvetica',7)
    canvas.drawString(45,24,'Original simulator study - no production-vehicle vulnerability claim')
    canvas.drawRightString(w-45,24,f'16 OCT 2026  /  {doc.page:02}')
    canvas.restoreState()


def architecture_drawing():
    d=Drawing(500,175)
    boxes=[(0,105,110,45,'OPERATOR','React / TypeScript'),(145,105,115,45,'AUTHORIZATION','Python gateway'),(295,105,110,45,'VIRTUAL ECUs','Steering channels'),(295,20,110,45,'VEHICLE MODEL','Fixed 50 ms tick'),(145,20,115,45,'EVIDENCE','SQLite event chain'),(0,20,110,45,'FORENSICS','Verified playback')]
    for x,y,w,h_,a,b in boxes:
        d.add(Rect(x,y,w,h_,fillColor=LIGHT,strokeColor=CYAN,strokeWidth=.8))
        d.add(String(x+9,y+27,a,fontName='Helvetica-Bold',fontSize=8.2,fillColor=INK))
        d.add(String(x+9,y+12,b,fontName='Helvetica',fontSize=7.2,fillColor=MUTED))
    for x1,y1,x2,y2 in [(110,127,145,127),(260,127,295,127),(350,105,350,65),(295,42,260,42),(145,42,110,42)]:
        d.add(Line(x1,y1,x2,y2,strokeColor=AMBER,strokeWidth=1.4))
    d.add(String(0,0,'No physical CAN, OBD, serial or real-EV actuation transport',fontSize=8,fontName='Helvetica',fillColor=AMBER))
    return d


def plot_response():
    d=Drawing(500,240); x0,y0,w,h_=42,35,435,156
    d.add(Rect(x0,y0,w,h_,fillColor=colors.white,strokeColor=colors.HexColor('#b5c7c9')))
    for t in range(9):
        x=x0+w*t/8;d.add(Line(x,y0,x,y0+h_,strokeColor=LIGHT));d.add(String(x-3,20,str(t),fontSize=7,fillColor=MUTED))
    for value in [-.2,-.1,0,.1,.2]:
        y=y0+(value+.22)/.44*h_;d.add(Line(x0,y,x0+w,y,strokeColor=LIGHT));d.add(String(12,y-2,f'{value:.1f}',fontSize=7,fillColor=MUTED))
    palette=[CYAN,AMBER,colors.HexColor('#735994')]
    database=sqlite3.connect(ROOT/'output/experiments/seed-42/experiments.sqlite3')
    for index,arch in enumerate(RESULT['architectures']):
        data=database.execute("SELECT payload_json FROM events WHERE run_id=? AND kind='frame' ORDER BY ordinal",(arch['recording_run_id'],)).fetchall()
        frames=[json.loads(row[0])['snapshot'] for row in data]
        max_angle=[32,28,35][index]
        points=[(x0+w*s['sim_time']/8,y0+(s['vehicle']['steer_deg']/max_angle+.22)/.44*h_) for s in frames]
        d.add(PolyLine(points,strokeColor=palette[index],strokeWidth=1.3))
        if index==0:
            target=[(x0+w*s['sim_time']/8,y0+(s['vehicle']['target_steer_deg']/max_angle+.22)/.44*h_) for s in frames]
            d.add(PolyLine(target,strokeColor=colors.HexColor('#899697'),strokeWidth=.7))
    database.close()
    d.add(String(42,227,'Normalized actuator response (model angle / configured maximum)',fontSize=8,fontName='Helvetica-Bold',fillColor=INK))
    d.add(String(200,3,'Simulation time (s)',fontSize=8,fillColor=MUTED))
    for i,(label,color) in enumerate(zip(['ASTER','VECTOR','NOMAD'],palette)):
        d.add(Line(45+i*100,205,56+i*100,205,strokeColor=color,strokeWidth=2))
        d.add(String(60+i*100,202,label,fontSize=6.5,fillColor=color))
    return d


# 1 - cover and abstract
p('AUTOMOTIVE CYBER-PHYSICAL RESEARCH / ORIGINAL SOFTWARE', 'SmallGW')
STORY.append(Spacer(1,28))
p('GHOSTWHEEL', 'H1GW')
STORY.append(Paragraph('GW-01',ParagraphStyle('Big',fontName='Helvetica-Bold',fontSize=62,leading=70,textColor=CYAN)))
p('A simulator-only command gateway, virtual vehicle laboratory<br/>and forensic evidence platform', 'H2GW')
STORY.append(Spacer(1,20))
table([['RESEARCH BUILD','0.1.0 / Windows desktop'],['MEASURED BACKEND','Original builtin vehicle models'],['EXPERIMENT EVIDENCE','3 seeds x 66 assertions; 22 source tests'],['INTEGRATION BOUNDARY','CARLA client/adapter included; server driving run unvalidated']], [135,365],False)
h('Abstract')
p('GW-01 is an original automotive cybersecurity demonstration built with Tauri, React, TypeScript, Python and SQLite, with an optional CARLA simulator adapter. It separates requested driving control from authorized simulator actuation, records the resulting state transitions, and tests a finite set of synthetic command faults. Three invented electric-vehicle profiles expose the same command contract while retaining independent model and controller state.')
p('At seeds 42, 7 and 2026, each experiment suite passed 66 assertions. Across the three suites, all 72 injected invalid commands were rejected and all nine missing-heartbeat trials entered their configured safe state. Each baseline reproduced its deterministic final state and every saved builtin physics frame was recomputed successfully. These are measured properties of this implementation and protocol, not estimates of security for OVMS, CARLA or a production EV. [E1, E2]')
p('The reference investigation combines documented interfaces with actual REA package inventory. Firmware decompilation was unavailable on this host. No VSEP software, covert vehicle-control capability, OEM message database or production-car vulnerability was recovered or implemented. [R1-R4, E3]')
p('Prepared for university technical review. The RESTRICTED label is an aesthetic. This report makes no official classification, agency affiliation, safety certification or OEM endorsement claim.', 'SmallGW')
page()

# 2

title(2,'System architecture and provenance')
STORY.append(architecture_drawing())
h('Original implementation, documented inspiration')
p('The system separates common services from configurable vehicle behavior. OVMS exposes vehicle hooks, typed metrics and event interfaces; those documented boundaries motivated the adapter pattern. GW-01 does not implement the OVMS control protocol. Its driving commands and virtual payloads are original. [R1, R2]')
p('The desktop shell owns a Python child process with a fresh launch token and ephemeral loopback port. React receives connection details through a narrow Tauri invocation. The Python service validates controls, advances independent model states, generates synthetic telemetry and commits evidence to SQLite. The interface is built from local assets and works without an external web service. [E4]')
table([['COMPONENT','IMPLEMENTATION / EVIDENCE'],['Operator console','React/TypeScript; actual state polling, control, experiments and read-only replay. src/; UI QA receipt.'],['Control policy','Python deterministic gateway; strict session, freshness, sequence, range and physical-envelope checks. gateway.py; source tests.'],['Virtual controllers','Independent first-order steering ECU state machines; dual-channel agreement check in VECTOR. ecu.py/model.py.'],['Simulation','Three original bicycle/longitudinal models at dt=0.05 s. No OEM calibration. model.py/engine.py.'],['Forensic store','SQLite WAL event chain; saved-frame playback and builtin state recomputation. recorder.py.'],['CARLA adapter','Matching local SDK/server only; explicit connect and owned actor. Contract tested; server driving run unvalidated. carla_adapter.py.']], [110,390])
p('The trust boundary is simulator actuation. No component opens a production-vehicle CAN, OBD, serial or diagnostic connection. No real-car steering or braking path exists in this implementation. The absence claim is bounded to the delivered source and dependency use reviewed here, not to all software on the host. [E4, E5]', 'SmallGW')
page()

# 3
title(3,'Model and authorization specification')
table([['PARAMETER','ASTER','VECTOR','NOMAD'],['Wheelbase (m)','2.65','2.96','3.25'],['Maximum modeled steer (deg)','32','28','35'],['Maximum steering rate (deg/s)','90','70','55'],['Actuator time constant (s)','0.15','0.21 / 0.2163','0.29'],['Steering channels','1','2, monitored','1'],['Throttle acceleration (m/s2)','3.2','3.8','2.7']], [205,98,98,99])
p('All values are original teaching parameters. Each profile owns its state and seeded pseudo-random generator. The model integrates longitudinal speed and a kinematic bicycle yaw relation; it omits tire force/slip, suspension, collision and calibrated EV powertrain behavior. These are limits of the inference, not discovered deficiencies in a real vehicle. [E4]')
p('The shared ground-plane convention is x forward, y right, positive yaw clockwise from above and positive steering right. The console preserves this CARLA-style handedness. [R3b, E4]')
p('yaw_rate = speed / wheelbase * tan(modeled_steer_deg * pi / 180)<br/>actuator_delta = (target - angle) * (1 - exp(-dt / tau))<br/>actuator_delta is bounded by configured_rate * dt', 'CodeGW')
h('Deterministic gateway decision')
p('A control envelope must contain exactly the defined fields: vehicle, steer, throttle, brake, sequence, issued tick, session and capability. Validation checks session/capability scope; integer sequencing; a nonfuture tick within a six-tick age budget; replay; finite/ranged numeric values; competing pedals; per-tick steering demand allowance; and the configured lateral-acceleration envelope. A repeated burst cannot repeatedly earn a fresh same-tick allowance. [E4, E5]')
p('Physical demand check: speed^2 * abs(tan(target_angle_deg * pi / 180)) / wheelbase &lt;= 5 m/s2. This is an illustrative policy. It is not a validated automotive safety threshold or a substitute for a vehicle safety case. The modeled actuator independently enforces its rate limit. [E4]')
h('Fail-closed behavior')
p('A rejected recognized command requests neutral steering, zero throttle and brake 0.35. An unroutable authenticated control envelope stops all virtual vehicles. Explicit stop uses brake 0.7. Modeled steering returns through its bounded actuator dynamics. Missing commands enter the safe state on the first tick after the 300 ms lease: tick seven, 350 ms of simulation time. Recording or CARLA runtime errors pause and latch reset-required state. A compromised host or stalled scheduler is outside the guarantee. [E5]')
page()

# 4
title(4,'Reproducible experimental method')
p('The experiment unit is a fresh builtin World, architecture, seed and finite input trace. Each baseline runs 160 ticks (8 simulated seconds) and 80 legitimate commands. The normalized requested steering signal has amplitude 0.18 and angular frequency 1.2 rad/s; throttle is 0.22. The same trace is repeated from a fresh initial condition and its deterministic final state is compared. [E1, E4]')
table([['SYNTHETIC TRIAL','EXPECTED OUTCOME'],['Duplicate accepted sequence','Reject: replayed_sequence; enter safe state'],['Expired issue tick','Reject: stale_command; enter safe state'],['Invalid simulation capability','Reject: unauthorized; enter safe state'],['Future issue tick','Reject: future_command; enter safe state'],['Steering value outside [-1,1]','Reject: out_of_range; enter safe state'],['Instantaneous full-lock demand','Reject: steering_slew_limit; enter safe state'],['Throttle and brake together','Reject: conflicting_pedals; enter safe state'],['Extra synthetic frame field','Reject: invalid_schema; enter safe state'],['Withheld command heartbeat','One watchdog trip; zero throttle and neutral demand']], [230,270])
p('Each trial runs in a new isolated model. The rejection trials include a legitimate neutral initialization so sequence and authorization context are explicit. The dropout trial advances seven fixed ticks without renewed input. No exploit packets, remote target or physical bus transmission are involved. [E4]')
h('Denominators and clocks')
p('Per seed: 24 injected invalid commands are expected to be rejected, plus three separate missing-heartbeat trials. The 27-trial count must not be described as 27 injected commands. The 66 assertions also check legitimate baseline acceptance, repeated-run state equality and recording recomputation. Three seeds are 42, 7 and 2026; they are reproducibility cases, not a random sample of every possible attack. [E1]')
p('Tracking RMSE compares requested versus modeled steering in degrees at every fixed tick. Gateway p95 is local elapsed perf_counter_ns wall time around validation and state application; it excludes HTTP, SQLite, rendering and actual physical response. Scheduling can change these latency observations. [E1, E4]')
page()

# 5
title(5,'Measured results - builtin simulation')
rows=[['PROFILE','TRACKING RMSE (deg)','GATEWAY P95 (ms)','BASELINE INPUTS']]
for arch in RESULT['architectures']:
    rows.append([arch['id'].upper(),f"{arch['tracking_rmse_deg']:.4f}",f"{arch['latency_p95_ms']:.4f}",f"{arch['baseline']['accepted']} accepted / {arch['baseline']['rejected']} rejected"])
table(rows,[105,140,125,130])
STORY.append(plot_response())
p('Figure 1. Actual saved baseline frames, seed 42. Requested normalized steering is gray; colored lines show configured actuator responses. Different time constants and bounds explain the model differences. They do not establish a production-vehicle comparison. [E1]', 'SmallGW')
h('Bounded resilience outcomes')
rows=[['SEED','ASSERTIONS','INVALID INPUTS REJECTED','TIMEOUT SAFE STOPS']]
for suite in VERIFY['experiment_suites']:
    totals=suite['totals'];rows.append([str(suite['seed']),f"{totals['passed']} / {totals['assertions']}",f"{totals['rejected']} / 24",'3 / 3'])
table(rows,[80,110,160,150])
p('All nine architecture/seed baselines reproduced their deterministic final state. For each baseline, 160 recorded physics frames and 80 commands were replayed and recomputed. Actual capability secrets were replaced by validity markers in the ledger. Reported terminal state digests are retained in verification.json. [E1, E2]')
p('These outcomes support the configured rejection/safe-state properties for the tested traces. They do not justify universal resilience, statistical confidence limits, hard real-time response claims or a finding about an OEM security boundary.', 'SmallGW')
page()

# 6
title(6,'Safety verification and threat model')
p('The source verification completed 22 unittest methods. Additional subcases include 1,500 bounded pseudorandom commands, malformed values, multiple corruption operations and three architecture/seed combinations in each experiment suite. Source hashes and interpreter/platform metadata are retained with the test output. Tests are evidence for the named build and boundary, not proof of exhaustive correctness. [E2, E5]')
table([['CHECK FAMILY','MEASURED PROPERTY'],['Authorization and scope','Wrong session/capability and unknown vehicle cannot acquire actuation. Desktop data endpoints require the launch secret.'],['Malformed input','NaN/infinity, oversized integers, lone-surrogate identity strings, duplicate keys, exponent overflow and oversized bodies fail safely.'],['Physical envelopes','Accepted requests and modeled actuator movement remain bounded; same-tick bursts cannot accumulate full lock.'],['Controller isolation','Inactive vehicles retain independent motion state. VECTOR channel disagreement is latched.'],['Lease and failure','Watchdog returns zero throttle; recording failure and CARLA failure inside a scenario prevent resume without reset.'],['HTTP boundary','Exact Host, allowlisted origin, explicit token, no wildcard CORS, no-store telemetry.'],['Forensic integrity','Altered payloads, deletions, metadata and fabricated summaries are rejected. Builtin frame recomputation matches.']], [135,365])
h('Adversary and exclusions')
p('The experiment adversary supplies invalid or stale envelopes at the application boundary, replays sequence numbers, withholds input or corrupts local records. Synthetic capabilities are deliberately invalid. Authentication is a local demonstration and does not defend against a host administrator reading process memory, local launch secrets or changing the installed binary.')
p('The system trusts the installed application, operating system and explicit local CARLA server. It excludes arbitrary malicious CARLA tick owners, production EV networks, real-time deadlines, certified safety behavior and active exploitation of OVMS or CARLA. Unknown or excluded behavior must not be presented as an observed vulnerability. [E4, E5]')
p('The review found and corrected bugs in this original implementation: exceptional numeric handling, accumulated same-tick slew allowance, unverified index summaries and failure-latch bypass paths. Regression tests address those reproductions. They are GW-01 engineering findings, not findings about the reference projects.', 'SmallGW')
page()

# 7
title(7,'Telemetry, evidence and forensic replay')
p('The recorder uses SQLite WAL and per-run ordered events. Initialization chains run identity, timestamp, kind, architecture, seed and initial state digest. Input records contain normalized command data and the decision; frames contain measured model state. Stop/pause transitions are explicit. Credentials are redacted to validity markers. [E4]')
p('event_hash = SHA256(previous_hash + canonical_event)<br/>canonical_event = {ordinal, kind, tick, payload}<br/>state_hash = SHA256(canonical_deterministic_projection)', 'CodeGW')
h('Two distinct replay operations')
p('<b>Verified playback:</b> verify the event order, previous/current hashes, terminal count/digest, metadata, per-frame digest, frame count and summary consistency. Return the saved frames for scrubbing and playback. The operator interface does not send driving controls while presenting them.')
p('<b>Builtin recomputation:</b> create a fresh World with the recorded seed/session, substitute a replay-only credential for valid markers, apply each saved envelope, advance fixed ticks, and compare every deterministic state digest. Host timing and database identity are not deterministic physics and are excluded from this projection. [E4, E5]')
h('What integrity does and does not establish')
p('A local SHA-256 chain exposes many partial modifications relative to its terminal digest. It does not establish who recorded the trace and does not prevent a privileged attacker from rewriting every event and anchor. No external signature, trusted timestamp or remote evidence escrow is implemented. The report deliberately avoids the term tamper-proof.')
p('CARLA runs receive verified saved-frame playback only. They are not replayed through builtin dynamics or through CARLA physics during this operation. CARLA has a separate recorder facility; GW-01 does not claim equivalence with it. [R3, E4]')
h('Resource and error behavior')
p('An interactive recording is limited to 8,000 ticks (400 simulated seconds), then pauses until reset. This bounds an individual run; accumulated runs still consume disk. Persistent storage failure pauses and latches the service, with no silent evidence repair. A partial recording may fail verification and must remain distinguishable from a complete run. [E4, E5]')
page()

# 8
title(8,'CARLA integration and technical limits')
p('The adapter targets CARLA 0.9.16 on loopback port 2000. The SDK client is included in the packaged sidecar. A separate compatible server is required. The adapter checks client/server version equality and refuses a world containing existing vehicle or walker actors. It configures a synchronous 50 ms step with 0.01 s substeps and at most 10 substeps, reloads while preserving settings, and spawns an owned allowlisted vehicle actor. [R3, R4, E4]')
p('The adapter sends batched VehicleControl commands, checks the batch response, advances one tick and reads the actor transform/velocity. It reads the physics front-left wheel angle separately from normalized steer. Disconnect attempts brake, destroys the owned actor and restores previous world settings. An adapter failure safe-stops/pauses and requires an explicit reset. [E4, E5]')
table([['FIELD / MEASUREMENT','INTERPRETATION'],['vehicle.steer_deg','Original virtual actuator model angle; not a measured CARLA tire angle'],['carla_observation.steer_normalized','Normalized command sent to CARLA, in [-1,1]'],['carla_observation.front_left_wheel_steer_deg','Physics wheel angle returned by CARLA after the tick'],['vehicle position / velocity in CARLA mode','Updated from the owned CARLA actor after a successful tick'],['CARLA run metadata','Actual client/server version, map, spawn pose, blueprint, fixed step and substeps']], [235,265])
h('Validation status')
p('<b>No CARLA server was available for this build.</b> SDK import and mocked API contract tests are available; they do not establish successful vehicle spawning, controls or physics behavior in a running server. No CARLA result appears in the measured builtin tables. A future server run must retain its own versions, map, seed, failures and telemetry before it supports a physics claim. [E2, E5]')
p('CARLA documents determinism prerequisites such as synchronous fixed steps, consistent substeps, a world reload per repetition and batched commands. These conditions are an experimental setup, not evidence of cross-platform bitwise identity. Traffic Manager is not used by this adapter. [R3]')
p('Explicitly disconnect CARLA before closing the app. An abrupt backend termination may leave the actor or synchronous settings in its external server; reset that simulator world before reconnecting. Process-tree cleanup alone is not external-server cleanup. This lifecycle path remains unvalidated.', 'SmallGW')
p('GW-01 does not add any actual EV connector. Read-only OVMS telemetry, parked convenience operations and electrically isolated hardware fixtures are potential separate projects, not implemented or validated capabilities in this release.', 'SmallGW')
page()

# 9
title(9,'REA investigation - observed and unknown')
p('REA 6.4.0 was used on publicly shipped reference artifacts. Ordinary source-reading tools were used for an OVMS interface snapshot at commit 4bb334a59bf3bee8208f579add8b242fa01c1a5c. Reading open source is not described as decompilation. The snapshot supports interface observations about vehicle hooks, CAN frame declarations, metrics and event listeners. [R2, E3]')
h('Offline firmware artifact')
p('Official main-channel OVMS firmware: 4,184,944 bytes. SHA-256:<br/><font name="Courier" size="7.6">7ca6e397fe4ff1d5317a1f40a1fd14703f302b5dfda112664fc938720ff419e2</font>')
p('Firmware signature inspection was unavailable: the advertised integration requires Linux and an absolute caller-supplied Binwalk command. Native/Android semantic decompilation providers were unavailable on this Windows ARM64 host. No firmware pseudocode, call graph, execution trace or source/build equivalence was recovered. This is a tooling limitation, not a firmware security finding. [E3]')
h('Supported static package inventory')
p('The officially linked OVMS Android client 5.2.4 APK was inspected without installing or executing it. It is a mobile client, not the OVMS3 controller firmware. Package size 24,090,580 bytes; SHA-256:<br/><font name="Courier" size="7.6">1ed0f575db6908723df48bbc54fce3d9a2353506c026dd0a2b11b3e484fcc69e</font>')
table([['REA OUTPUT','OBSERVATION'],['Inventory graph','1,878 nodes; 2,033 occurrences; 2,032 edges'],['Observed entries','AndroidManifest.xml, classes.dex, classes2.dex'],['Coverage','Complete for the archive inventory substep only'],['Limits','No APK signature validation, permission semantics, authentication or runtime/network observation']], [150,350])
p('Inventory Evidence ID:<br/><font name="Courier" size="7">ev_7e8a22a497006251fc2d9aa436f3a65549732c847d5a9a64decde904339b498b</font><br/>Inspection Evidence ID:<br/><font name="Courier" size="7">ev_fab81af93b961f9eb706b0710a44a8a69cd6be18adfe561615afca28f0dd7ced</font>', 'SmallGW')
p('Full evidence and exact blockers are retained in evidence/rea-ovms-package.json and evidence/rea-summary.json. Archive names colliding under case folding were reported as an inventory caveat, not an observed attack. No artifact was flashed or installed. These artifacts are research inputs and are excluded from the application installer. [E3]')
page()

# 10
title(10,'Reproduction, acceptance and next work')
p('The self-contained university demonstration requires the Windows application and WebView2; no CARLA server or vehicle connection is needed. The source package includes dependency lock files, the Python engine, Tauri shell, tests, reproducible scripts, evidence receipts and the presentation guide. Build prerequisites and compatibility-toolchain status are recorded separately from runtime acceptance. [E4, E6]')
p('npm ci<br/>$env:PYTHONPATH = (Join-Path $PWD "backend")<br/>python -m ghostwheel.server --port 8765 --db output/dev.sqlite3<br/># second terminal<br/>npm run dev<br/># retained evidence and seeded repetition<br/>python scripts/verify.py<br/>npm run desktop:build', 'CodeGW')
p('The README contains copyable PowerShell commands. Verification writes test output, source hashes, host metadata, per-seed JSON and SQLite experiments. UI experiment runs use the same isolated Python protocol. Runtime state lives under the application local data directory in the installed desktop build. [E4]')
p('The unsigned Windows x64 GNU compatibility release was packaged as an NSIS installer and portable ZIP. Native WebView2 and per-user installation smoke tests exercised the bundled React/Python link, keyboard steering, safe stop, malformed-command rejection and process-tree cleanup. The supported MSVC recipe is provided as CI configuration; it was not executed here. Exact artifact identities and observed checks are in the delivery receipts. [E6]')
h('Acceptance interpretation')
table([['COMPLETE / MEASURED','UNVALIDATED / EXCLUDED'],['Builtin steering, synthetic command scenarios, recording, replay and seeded experiments','Full running CARLA server driving test'],['22 source tests and 198 experiment assertions across three seeds','Hardware fixtures, real EV telemetry or parked conveniences'],['REA package inventory plus documented source interfaces','OVMS firmware decompilation or source/binary equivalence'],['Windows packaging and interaction status documented in delivery receipts','OEM vulnerabilities, covert control, automotive certification, formal safety proof']], [250,250])
h('Research questions that remain open')
p('A next study should validate CARLA 0.9.16 end to end on a suitable graphics host, use real physics wheel-angle response for simulator-specific metrics, and retain run metadata. Additional original virtual bus scheduling or more complete controller models could support new network timing questions. Such work needs its own protocol; the current synthetic message generator cannot answer wire-level timing questions.')
p('For evidence provenance, independently sign or escrow terminal digests. For statistical work, pre-register parameter sweeps, report distributions and failures, and avoid security rankings of uncalibrated models. These are proposed extensions, not delivered or measured capabilities.')
page()

# 11
title(11,'References and retained evidence')
p('References were accessed 16 October 2026. Project documentation may change; the ledger identifies versioned pages, artifact hashes and the pinned source commit. Claims about this implementation refer to the retained local files and test receipts below.', 'SmallGW')
refs=[
('R1','Open Vehicles: OVMS3 introduction; metrics and Web UI.','https://docs.openvehicles.com/en/latest/introduction.html'),
('R2','Open Vehicles: vehicle/CAN/metrics/event interfaces at commit 4bb334a59bf3bee8208f579add8b242fa01c1a5c. Exact file URLs and hashes are in source-ledger.json.','https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3'),
('R3','CARLA 0.9.16: Python API, synchronous time-step and recorder documentation.','https://carla.readthedocs.io/en/0.9.16/python_api/'),
('R3a','CARLA 0.9.16: synchrony and time step.','https://carla.readthedocs.io/en/0.9.16/adv_synchrony_timestep/'),
('R3b','CARLA: coordinate handedness and transforms.','https://carla.readthedocs.io/en/latest/coordinates/'),
('R4','CARLA project: 0.9.16 Windows Python SDK release files and checksums.','https://pypi.org/project/carla/0.9.16/'),
('R5','CAN in Automation: CAN CC broadcast data link, identifiers, payload and arbitration context.','https://www.can-cia.org/can-knowledge/can-cc'),
('R6','Bosch Mobility: control units and zonal ECU architecture context.','https://www.bosch-mobility.com/en/solutions/control-units/'),
('R7','AUTOSAR: SecOC protocol specification, R23-11; authenticity/freshness are distinct from link error detection. GW-01 is not an implementation.','https://www.autosar.org/fileadmin/standards/R23-11/FO/AUTOSAR_FO_PRS_SecOcProtocol.pdf'),
('R8','Tauri 2: external binaries and Windows packaging.','https://v2.tauri.app/develop/sidecar/'),
]
for ident,desc,url in refs:
    p(f'<b>[{ident}]</b> {escape(desc)}<br/><link href="{url}" color="#157a83">{escape(url)}</link>', 'SmallGW')
h('Local evidence index')
for ident,text in [
('E1','output/experiments/seed-42/results.json; seed-7/results.json; seed-2026/results.json; corresponding SQLite ledgers. Measured original-model results.'),
('E2','output/verification/verification.json and tests.txt. Interpreter/platform, tested source hashes, three-seed receipts and final source-test result.'),
('E3','evidence/source-ledger.json; rea-summary.json; rea-ovms-package.json; source-snapshots/. Exact source/artifact identities, REA Evidence IDs and limitations.'),
('E4','Original implementation: backend/ghostwheel/, src/, src-tauri/; configuration and scripts. Model definitions and local behavior, not third-party vulnerabilities.'),
('E5','tests/test_system.py. Safety boundary, numeric parsing, sequences, per-tick allowance, recorder corruption/failure, virtual ECU and mocked CARLA contract tests.'),
('E6','output/verification/desktop-build.json; frontend-qa.json; desktop-native-smoke.json; desktop-install-smoke.json; desktop-installed-native-smoke.json. Installer hashes and compatibility limits are in output/release/.')]:
    p(f'<b>[{ident}]</b> {escape(text)}','SmallGW')

page()
title(12,'Appendix - native Windows console')
screenshot = ROOT / 'output/verification/native-console.png'
if screenshot.exists():
    from PIL import Image as PILImage
    with PILImage.open(screenshot) as source_image:
        image_width, image_height = source_image.size
    STORY.append(FlowImage(str(screenshot), width=500, height=500 * image_height / image_width))
    STORY.append(Spacer(1,12))
p('Figure 2. Actual native WebView2 console after a keyboard-steering and safe-stop trial. Values come from the simulator service; the image illustrates the interface, not a separate performance experiment. The command-rejection and safe-stop observations are recorded in the native QA receipt. [E6]', 'SmallGW')
h('Observation and identity')
p('The native smoke test launches the application with temporary child-only debugging flags so it can observe the bundled webview. It verifies that React mounts, the Tauri connection descriptor reaches the authenticated service, keyboard demand changes modeled steering, safe stop clears demand, malformed control is rejected and the backend terminates with the owned native host. The production application does not set a remote-debugging flag. [E6]')
p('The installer test uses a scoped per-user install and repeats the native checks from the installed executable. This is one host-level compatibility observation, not certification across every Windows machine. The local release uses GNU because MSVC build tools were absent; the separately supplied supported MSVC CI recipe remains unexecuted here. [E6]')
p('CARLA server driving, external hardware and actual production EV connectivity remain outside these observations. The self-contained simulator is the measured backend throughout the reported experiments.', 'SmallGW')

SimpleDocTemplate(str(OUT),pagesize=(595.2756,841.8898),rightMargin=45,leftMargin=45,topMargin=60,bottomMargin=52,
    title='GHOSTWHEEL GW-01 Technical Research Report',author='GHOSTWHEEL Research',subject='Simulator-only automotive cybersecurity demonstration').build(STORY,onFirstPage=footer,onLaterPages=footer)
print(str(OUT))
