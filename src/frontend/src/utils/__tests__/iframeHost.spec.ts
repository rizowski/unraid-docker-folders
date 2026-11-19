import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { THEME_VARS, applyTheme, applyThemeParam, listenForThemeUpdates, sanitizeTheme } from '../iframeHost';

const root = () => document.documentElement;

function clearVars() {
  for (const v of THEME_VARS) root().style.removeProperty(v);
}

describe('sanitizeTheme', () => {
  it('keeps known names with string values', () => {
    expect(sanitizeTheme({ '--text-color': ' #fff ', '--border-color': '#333' })).toEqual({
      '--text-color': '#fff',
      '--border-color': '#333',
    });
  });

  it('drops unknown names, non-strings, empty and oversized values', () => {
    expect(
      sanitizeTheme({
        '--evil': 'x',
        color: 'red',
        '--text-color': 5,
        '--border-color': '   ',
        '--background-color': 'a'.repeat(201),
        '--button-text-color': { toString: () => 'x' },
      }),
    ).toEqual({});
  });

  it('returns nothing for non-objects', () => {
    expect(sanitizeTheme(null)).toEqual({});
    expect(sanitizeTheme('--text-color')).toEqual({});
    expect(sanitizeTheme(['#fff'])).toEqual({});
  });
});

describe('applyTheme', () => {
  beforeEach(clearVars);
  afterEach(clearVars);

  it('sets known variables and ignores others', () => {
    applyTheme({ '--text-color': '#eee', '--evil': 'x' });
    expect(root().style.getPropertyValue('--text-color')).toBe('#eee');
    expect(root().style.getPropertyValue('--evil')).toBe('');
  });

  it('removes a known variable that a replacing update no longer carries', () => {
    applyTheme({ '--text-color': '#eee', '--border-color': '#333' });
    applyTheme({ '--text-color': '#111' }, true);
    expect(root().style.getPropertyValue('--text-color')).toBe('#111');
    expect(root().style.getPropertyValue('--border-color')).toBe('');
  });

  it('keeps variables the update does not carry when not replacing', () => {
    applyTheme({ '--text-color': '#eee', '--border-color': '#333' });
    applyTheme({ '--text-color': '#111' });
    expect(root().style.getPropertyValue('--border-color')).toBe('#333');
  });
});

describe('applyThemeParam', () => {
  beforeEach(clearVars);
  afterEach(() => {
    clearVars();
    window.history.replaceState(null, '', '/');
  });

  it('applies the theme from the URL, known names only', () => {
    const theme = encodeURIComponent(JSON.stringify({ '--background-color': '#111', '--evil': 'x' }));
    window.history.replaceState(null, '', `/?theme=${theme}`);
    applyThemeParam();
    expect(root().style.getPropertyValue('--background-color')).toBe('#111');
    expect(root().style.getPropertyValue('--evil')).toBe('');
  });

  it('ignores a malformed theme param', () => {
    window.history.replaceState(null, '', '/?theme=%7Bnope');
    expect(() => applyThemeParam()).not.toThrow();
  });
});

describe('listenForThemeUpdates', () => {
  let parentFrame: HTMLIFrameElement;
  let stop: () => void;
  const realParent = Object.getOwnPropertyDescriptor(window, 'parent');

  function send(init: { data: unknown; origin?: string; source?: Window | null }) {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: init.data,
        origin: init.origin ?? window.location.origin,
        source: init.source === undefined ? parentFrame.contentWindow : init.source,
      }),
    );
  }

  beforeEach(() => {
    clearVars();
    parentFrame = document.createElement('iframe');
    document.body.appendChild(parentFrame);
    Object.defineProperty(window, 'parent', { value: parentFrame.contentWindow, configurable: true });
    stop = listenForThemeUpdates();
  });

  afterEach(() => {
    stop();
    if (realParent) Object.defineProperty(window, 'parent', realParent);
    else Reflect.deleteProperty(window, 'parent');
    parentFrame.remove();
    clearVars();
  });

  it('applies a valid message from the parent on the same origin', () => {
    send({ data: { type: 'docker-folders-theme', theme: { '--background-color': '#111', '--text-color': '#eee' } } });
    expect(root().style.getPropertyValue('--background-color')).toBe('#111');
    expect(root().style.getPropertyValue('--text-color')).toBe('#eee');
  });

  it('replaces the previous theme, dropping variables no longer sent', () => {
    send({ data: { type: 'docker-folders-theme', theme: { '--background-color': '#fff', '--border-color': '#ccc' } } });
    send({ data: { type: 'docker-folders-theme', theme: { '--background-color': '#111' } } });
    expect(root().style.getPropertyValue('--background-color')).toBe('#111');
    expect(root().style.getPropertyValue('--border-color')).toBe('');
  });

  it('ignores a message from another origin', () => {
    send({ origin: 'https://evil.example', data: { type: 'docker-folders-theme', theme: { '--text-color': '#f00' } } });
    expect(root().style.getPropertyValue('--text-color')).toBe('');
  });

  it('ignores a message whose source is not the parent', () => {
    send({ source: window, data: { type: 'docker-folders-theme', theme: { '--text-color': '#f00' } } });
    expect(root().style.getPropertyValue('--text-color')).toBe('');
  });

  it('ignores another message type', () => {
    send({ data: { type: 'docker-folders-resize', theme: { '--text-color': '#f00' } } });
    expect(root().style.getPropertyValue('--text-color')).toBe('');
  });

  it('ignores unknown keys and non-string values', () => {
    send({
      data: {
        type: 'docker-folders-theme',
        theme: { '--evil': 'x', background: 'red', '--text-color': 12, '--border-color': '#333' },
      },
    });
    expect(root().style.getPropertyValue('--evil')).toBe('');
    expect(root().style.getPropertyValue('background')).toBe('');
    expect(root().style.getPropertyValue('--text-color')).toBe('');
    expect(root().style.getPropertyValue('--border-color')).toBe('#333');
  });

  it('survives a payload that is not an object', () => {
    expect(() => send({ data: 'docker-folders-theme' })).not.toThrow();
    expect(() => send({ data: null })).not.toThrow();
    expect(() => send({ data: { type: 'docker-folders-theme', theme: null } })).not.toThrow();
  });

  it('stops listening after the returned cleanup runs', () => {
    stop();
    send({ data: { type: 'docker-folders-theme', theme: { '--text-color': '#f00' } } });
    expect(root().style.getPropertyValue('--text-color')).toBe('');
  });

  it('does nothing when the page is not in a frame', () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
    send({ source: window, data: { type: 'docker-folders-theme', theme: { '--text-color': '#f00' } } });
    expect(root().style.getPropertyValue('--text-color')).toBe('');
  });
});
