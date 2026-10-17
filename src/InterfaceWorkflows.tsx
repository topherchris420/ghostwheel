import { useState } from 'react';
import { ArrowUpRight, LockKeyhole, Play, Radio, ShieldCheck } from 'lucide-react';
import { SectionTitle } from './components';

type InterfaceView = 'simulation' | 'monitor';

export default function InterfaceWorkflows() {
  const [view, setView] = useState<InterfaceView>('simulation');

  return (
    <section className="panel connector-panel" aria-label="Vehicle interface workflows">
      <SectionTitle number="00" title="Choose your interface workflow">
        <span className="tag cyan-tag">SIM CONTROL + READ-ONLY HARDWARE OBSERVATION</span>
      </SectionTitle>
      <p>
        Ghostwheel offers two separate workflows. Only simulated vehicles accept steering,
        acceleration, or braking requests.
      </p>
      <div className="profile-list connector-list">
        <div className={view === 'simulation' ? 'active' : ''}>
          <span className="profile-index">INTERACTIVE</span>
          <h3>Simulation controls</h3>
          <p>Drive the built-in fleet or a local CARLA simulation and replay the results.</p>
          <button
            type="button"
            className="button secondary"
            aria-pressed={view === 'simulation'}
            onClick={() => setView('simulation')}
          >
            <Play size={13} />
            {view === 'simulation' ? 'Showing simulator setup' : 'Show simulator setup'}
          </button>
        </div>
        <div className={view === 'monitor' ? 'active' : ''}>
          <span className="profile-index">PASSIVE</span>
          <h3>Physical vehicle diagnostics</h3>
          <p>Observe authorized CAN or serial data, including PACMod3 status, from a local ROS 2 process.</p>
          <button
            type="button"
            className="button secondary"
            aria-pressed={view === 'monitor'}
            onClick={() => setView('monitor')}
          >
            <Radio size={13} />
            {view === 'monitor' ? 'Showing monitor setup' : 'Show monitor setup'}
          </button>
        </div>
      </div>
      {view === 'simulation' ? (
        <div className="protocol-fail">
          <ShieldCheck size={15} />
          <div>
            <b>Simulator control is available now</b>
            <p>
              Use Operations for the built-in fleet or the CARLA bridge below. The optional ROS 2
              node also accepts Autoware commands into a separate synthetic HAL.
            </p>
          </div>
        </div>
      ) : (
        <div className="protocol-fail">
          <LockKeyhole size={15} />
          <div>
            <b>Hardware observation runs locally, outside this browser</b>
            <p>
              Build <code>ros2/ghostwheel_vehicle_interface</code> in your Autoware workspace, then
              run <code>ros2 run ghostwheel_vehicle_interface ghostwheel_vehicle_interface</code> with
              parameters <code>--ros-args -p interface_type:=can -p can_device:=can0</code>.
            </p>
            <p>
              Optional PACMod3 observation: after installing pacmod3_msgs, launch
              {' '}<code>ros2 run ghostwheel_vehicle_interface ghostwheel_pacmod3_adapter</code>.
              This browser does not connect to ROS. Physical actuation remains disabled.
            </p>
            <p>
              <a
                href="https://github.com/topherchris420/ghostwheel/tree/main/ros2/ghostwheel_vehicle_interface"
                target="_blank"
                rel="noreferrer"
              >
                ROS 2 setup and requirements <ArrowUpRight size={12} />
              </a>
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
