import { useEffect, useRef } from 'react';
import { FileText, LifeBuoy, LockKeyhole, MonitorSmartphone, ShieldCheck, X } from 'lucide-react';
import ghostwheelLicense from '../LICENSE?raw';
import barlowLicense from '../public/licenses/barlow-condensed-OFL.txt?raw';
import dmSansLicense from '../public/licenses/dm-sans-OFL.txt?raw';
import plexLicense from '../public/licenses/ibm-plex-mono-OFL.txt?raw';
import { EDITION_NAME, edition } from './api';

const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL;

const PRIVACY = {
  browser:
    'The simulator runs entirely in this browser tab. Driving data, recordings and experiment results stay on your device and are cleared when you close the tab, so export anything you want to keep. There are no accounts, cookies, analytics or trackers; the page only remembers whether you have seen Quick start. The site host keeps standard web-server request logs.',
  desktop:
    'The simulator runs on this computer. Its service listens only on 127.0.0.1 and requires a fresh secret on every launch. Recordings are kept in %LOCALAPPDATA%\\research.ghostwheel.gw01\\ghostwheel.sqlite3. There are no accounts, analytics or trackers.',
  local:
    'This developer build talks to a Python simulator on 127.0.0.1:8765. Recordings go to the database passed with --db. There are no accounts, analytics or trackers.',
} as const;

const NOTICES = [
  { name: 'GHOSTWHEEL', license: 'MIT', text: ghostwheelLicense },
  { name: 'DM Sans font', license: 'SIL OFL 1.1', text: dmSansLicense },
  { name: 'Barlow Condensed font', license: 'SIL OFL 1.1', text: barlowLicense },
  { name: 'IBM Plex Mono font', license: 'SIL OFL 1.1', text: plexLicense },
];

/** Product, privacy and license information. Loaded on demand from the header or footer. */
export default function About({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="welcome-dialog about-dialog"
      aria-labelledby="about-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="welcome-topline">
        <span>GHOSTWHEEL / ABOUT</span>
        <button type="button" onClick={onClose} aria-label="Close about GHOSTWHEEL">
          <X size={18} />
        </button>
      </div>
      <div className="welcome-content">
        <div className="welcome-kicker">
          <MonitorSmartphone size={17} /> {EDITION_NAME[edition].toUpperCase()} · VERSION{' '}
          {__APP_VERSION__}
        </div>
        <h2 id="about-title">GHOSTWHEEL GW-01</h2>
        <p className="welcome-description">
          An interactive automotive cybersecurity simulator. Drive fictional electric vehicles, send
          them synthetic faulty commands, and see exactly how a command gateway rejects them and
          brings the vehicle to a safe stop. Built for teaching, training and research.
        </p>
        <div className="about-grid">
          <section>
            <ShieldCheck size={17} />
            <h3>Scope and safety</h3>
            <p>
              Simulation only. The vehicles, ECUs, CAN frames and attack scenarios are synthetic and
              cannot connect to a real vehicle. Results describe this simulator and its finite test
              scenarios. They are not findings about production vehicles, a safety certification or
              an OEM endorsement.
            </p>
          </section>
          <section>
            <LockKeyhole size={17} />
            <h3>Your data</h3>
            <p>{PRIVACY[edition]}</p>
          </section>
        </div>
        {edition === 'browser' && (
          <p className="about-edition-note">
            The browser edition runs the same deterministic simulator as the Windows desktop app.
            The desktop app adds the optional CARLA bridge and keeps recordings between sessions.
          </p>
        )}
        <h3 className="about-heading">
          <FileText size={15} /> Licenses
        </h3>
        <div className="about-licenses">
          {NOTICES.map((notice) => (
            <details key={notice.name}>
              <summary>
                <b>{notice.name}</b> <span>{notice.license}</span>
              </summary>
              <pre>{notice.text.replace(/^﻿/, '')}</pre>
            </details>
          ))}
          <p>
            Also includes React and React DOM (MIT) and Lucide icons (ISC)
            {edition === 'desktop' ? ', packaged with Tauri (MIT or Apache-2.0)' : ''}.
          </p>
        </div>
        {SUPPORT_URL && (
          <a
            className="button secondary about-support"
            href={SUPPORT_URL}
            target="_blank"
            rel="noreferrer"
          >
            <LifeBuoy size={15} /> Get support
          </a>
        )}
      </div>
    </dialog>
  );
}
