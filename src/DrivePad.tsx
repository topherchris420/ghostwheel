import type { PointerEvent, KeyboardEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import type { ConsoleModel } from './useConsole';

/** Pointer capture ensures release/cancellation clears a held virtual control. */
export default function DrivePad({ m }: { m: ConsoleModel }) {
  const disabled = !m.armed || !!m.replay || !!m.busy || !!m.snapshot?.paused;
  const controls = [
    {
      label: 'Steer left',
      icon: ArrowLeft,
      active: m.steer < 0,
      start: () => m.setSteer(-0.4),
      stop: () => m.setSteer(0),
    },
    {
      label: 'Accelerate',
      icon: ArrowUp,
      active: m.throttle > 0,
      start: () => {
        m.setThrottle(0.3);
        m.setBrake(0);
      },
      stop: () => m.setThrottle(0),
    },
    {
      label: 'Brake',
      icon: ArrowDown,
      active: m.brake > 0,
      start: () => {
        m.setBrake(0.7);
        m.setThrottle(0);
      },
      stop: () => m.setBrake(0),
    },
    {
      label: 'Steer right',
      icon: ArrowRight,
      active: m.steer > 0,
      start: () => m.setSteer(0.4),
      stop: () => m.setSteer(0),
    },
  ];
  return (
    <div className="drive-pad">
      <p>
        HOLD TO DRIVE <span>Release to coast · Safe Stop to finish</span>
      </p>
      <div>
        {controls.map((control) => (
          <button
            key={control.label}
            type="button"
            disabled={disabled}
            aria-label={control.label}
            aria-pressed={control.active}
            className={control.active ? 'held' : ''}
            onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              control.start();
            }}
            onPointerUp={control.stop}
            onPointerCancel={control.stop}
            onLostPointerCapture={control.stop}
            onBlur={control.stop}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (!event.repeat) control.start();
              }
            }}
            onKeyUp={(event) => {
              if (event.key === 'Enter') control.stop();
            }}
          >
            <control.icon size={20} />
            <span>{control.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
