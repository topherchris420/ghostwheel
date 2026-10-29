import { useEffect, useMemo, useRef } from 'react';
import { Download } from 'lucide-react';
import { SectionTitle, saveText } from './components';
import { clock, storyMarkdown, tellRun, type Moment } from './story';
import type { ConsoleModel } from './useConsole';

/** Recorded reason codes, quoted in backticks by the story, render as code. */
const words = (text: string) =>
  text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/** The run, told plainly: the recording's decisions in order, each one a way into the replay. */
export default function StoryPanel({
  m,
  onSeek,
}: {
  m: ConsoleModel;
  onSeek: (moment: Moment) => void;
}) {
  const { replay, replayIndex, playing, boot } = m;
  const profile = boot?.architectures.find((a) => a.id === replay?.run.architecture_id);
  const story = useMemo(() => (replay ? tellRun(replay, profile) : null), [replay, profile]);
  const list = useRef<HTMLOListElement>(null);
  // The moment the replay has most recently passed.
  const current =
    story?.moments.reduce((found, moment, i) => (moment.frame <= replayIndex ? i : found), -1) ??
    -1;
  useEffect(() => {
    // Keep the current moment in view while the replay plays, without scrolling the page.
    const container = list.current,
      item = container?.children[current] as HTMLElement | undefined;
    if (!playing || !container || !item) return;
    if (
      item.offsetTop < container.scrollTop ||
      item.offsetTop + item.offsetHeight > container.scrollTop + container.clientHeight
    )
      container.scrollTop = item.offsetTop - 12;
  }, [current, playing]);
  useEffect(() => {
    // Another recording starts its story from the top.
    if (list.current) list.current.scrollTop = 0;
  }, [story]);
  if (!replay || !story) return null;
  return (
    <section className="panel story-panel">
      <SectionTitle number="03" title="The run, told plainly">
        <span className={story.verified ? 'tag cyan-tag' : 'tag amber-tag'}>
          {story.verified ? 'VERIFIED RECORDING' : 'NOT VERIFIED HERE'}
        </span>
        <button
          className="icon-button"
          aria-label="Save this story as Markdown"
          title="Save this story as Markdown"
          onClick={() => {
            saveText(
              storyMarkdown(replay, story),
              `ghostwheel-story-${replay.run.id}.md`,
              'text/markdown',
            );
            m.setNotice(
              'Download requested. The story carries the recording’s verification status.',
            );
          }}
        >
          <Download size={13} />
        </button>
      </SectionTitle>
      <p className={'story-standing ' + (story.verified ? 'verified' : 'unverified')}>
        {story.standing}
      </p>
      <ol className="story-moments" ref={list}>
        {story.moments.map((moment, i) => (
          <li
            key={`${moment.tick}-${i}`}
            className={`story-moment ${moment.tone}${i === current ? ' current' : ''}`}
            aria-current={i === current ? 'step' : undefined}
          >
            <button
              className="story-time"
              aria-label={`Show ${clock(moment.time)}, tick ${moment.tick}, in the replay`}
              onClick={() => onSeek(moment)}
            >
              <b>{clock(moment.time)}</b>
              <span>T+{moment.tick}</span>
            </button>
            <p>{words(moment.text)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
