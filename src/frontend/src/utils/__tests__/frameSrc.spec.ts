// include/frameSrc.js is static browser JavaScript that the Unraid pages load
// with a <script> tag. It has no module exports, so the test runs the file
// against jsdom's window, the way the browser does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { THEME_VARS } from '../iframeHost';
// ?raw hands over the file's text, so the test runs the exact file that ships.
import FRAME_SRC from '../../../../backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/frameSrc.js?raw';

type FakeFrame = { contentWindow: { postMessage: ReturnType<typeof vi.fn> } };
type W = Window & {
  dockerFoldersReadTheme: () => Record<string, string>;
  dockerFoldersWatchTheme: (getFrame: () => FakeFrame | null) => (force?: boolean) => void;
  dockerFoldersFrameSrc: (page: string) => string;
};
const w = window as unknown as W;
const root = () => document.documentElement;

describe('include/frameSrc.js', () => {
  let post: ReturnType<typeof vi.fn>;
  let frame: FakeFrame;
  // Watchers from earlier tests stay alive on the shared document, so each one
  // must close over its own frame, not the reassigned variable.
  const own = () => {
    const mine = frame;
    return () => mine;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    new Function(FRAME_SRC).call(window);
    post = vi.fn();
    frame = { contentWindow: { postMessage: post } };
    root().style.setProperty('--background-color', '#fff');
    root().style.setProperty('--text-color', '#111');
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const v of THEME_VARS) root().style.removeProperty(v);
    root().className = '';
  });

  it('reads only the variables the theme defines', () => {
    expect(w.dockerFoldersReadTheme()).toEqual({ '--background-color': '#fff', '--text-color': '#111' });
  });

  it('puts the same theme in the frame URL', () => {
    const url = new URL(w.dockerFoldersFrameSrc('widget.html'), 'http://x');
    expect(JSON.parse(url.searchParams.get('theme') as string)).toEqual(w.dockerFoldersReadTheme());
  });

  it('posts the new theme to the frame after a class change, debounced', async () => {
    w.dockerFoldersWatchTheme(own());
    root().style.setProperty('--background-color', '#111');
    root().classList.add('nr-dark');
    root().style.setProperty('--text-color', '#eee');
    await vi.advanceTimersByTimeAsync(100);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      { type: 'docker-folders-theme', theme: { '--background-color': '#111', '--text-color': '#eee' } },
      window.location.origin,
    );
  });

  it('does not post when the values did not change', async () => {
    w.dockerFoldersWatchTheme(own());
    root().classList.add('unrelated');
    await vi.advanceTimersByTimeAsync(100);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts on force even when nothing changed, and tolerates a missing frame', () => {
    const send = w.dockerFoldersWatchTheme(own());
    send(true);
    expect(post).toHaveBeenCalledTimes(1);
    const none = w.dockerFoldersWatchTheme(() => null);
    expect(() => none(true)).not.toThrow();
  });

  it('sends the latest theme on a forced send after a change made while no frame existed', async () => {
    let current: FakeFrame | null = null;
    const send = w.dockerFoldersWatchTheme(() => current);
    root().style.setProperty('--background-color', '#111');
    root().classList.add('nr-dark');
    await vi.advanceTimersByTimeAsync(100);
    current = frame;
    send(true);
    expect(post).toHaveBeenCalledWith(
      { type: 'docker-folders-theme', theme: { '--background-color': '#111', '--text-color': '#111' } },
      window.location.origin,
    );
  });
});
