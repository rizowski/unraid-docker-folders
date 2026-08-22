import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAdoptForm, type AdoptConfig, type AdoptFields } from '../unraidHandoff';

vi.mock('@/utils/csrf', () => ({
  getCsrfToken: vi.fn(() => 'tok123'),
}));

import { getCsrfToken } from '@/utils/csrf';

function config(overrides: Partial<AdoptConfig> = {}): AdoptConfig {
  return {
    Name: 'Port 80',
    Target: '80',
    Default: '18081',
    Mode: 'tcp',
    Description: '',
    Type: 'Port',
    Display: 'always',
    Required: 'false',
    Mask: 'false',
    Value: '18081',
    ...overrides,
  };
}

function data(overrides: Partial<AdoptFields> = {}): AdoptFields {
  return {
    fields: {
      contName: 'Adopt2',
      contRepository: 'nginx:alpine',
      contNetwork: 'bridge',
      contWebUI: '',
      contIcon: '',
    },
    configs: [config()],
    unmapped: [],
    imageEnvKnown: true,
    portsPublished: true,
    networkDriver: 'bridge',
    managed: null,
    ...overrides,
  };
}

/** All hidden inputs with a given name, in document order. */
function valuesOf(form: HTMLFormElement, name: string): string[] {
  return Array.from(form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)).map(
    (i) => i.value,
  );
}

describe('buildAdoptForm', () => {
  beforeEach(() => {
    vi.mocked(getCsrfToken).mockReturnValue('tok123');
  });

  it('posts to Unraid and targets the page around the iframe', () => {
    // _parent, not _self: submitting into the iframe would render Unraid's
    // progress log inside our tab instead of taking over the page.
    const form = buildAdoptForm(data());

    expect(form.method.toLowerCase()).toBe('post');
    expect(form.getAttribute('action')).toBe('/Docker/UpdateContainer');
    expect(form.target).toBe('_parent');
  });

  it('sends every scalar field, including the empty ones', () => {
    // postToXML reads most cont* keys without a null-coalesce, so dropping an
    // empty one is a PHP warning on Unraid's side rather than a default.
    const form = buildAdoptForm(data());

    expect(valuesOf(form, 'contName')).toEqual(['Adopt2']);
    expect(valuesOf(form, 'contWebUI')).toEqual(['']);
    expect(valuesOf(form, 'contIcon')).toEqual(['']);
  });

  it('marks the container as an existing one being replaced', () => {
    const form = buildAdoptForm(data());

    expect(valuesOf(form, 'existingContainer')).toEqual(['Adopt2']);
  });

  it('sends the ten parallel config arrays in matching order', () => {
    const form = buildAdoptForm(
      data({
        configs: [
          config({ Type: 'Port', Target: '80', Value: '18081', Mode: 'tcp' }),
          config({ Type: 'Path', Target: '/data', Value: 'vol', Mode: 'rw' }),
          config({ Type: 'Variable', Target: 'TZ', Value: 'UTC', Mode: '' }),
        ],
      }),
    );

    expect(valuesOf(form, 'confType[]')).toEqual(['Port', 'Path', 'Variable']);
    expect(valuesOf(form, 'confTarget[]')).toEqual(['80', '/data', 'TZ']);
    expect(valuesOf(form, 'confValue[]')).toEqual(['18081', 'vol', 'UTC']);
    expect(valuesOf(form, 'confMode[]')).toEqual(['tcp', 'rw', '']);
  });

  it('sends every one of the nine attribute arrays', () => {
    const form = buildAdoptForm(data());

    for (const key of [
      'confName[]',
      'confTarget[]',
      'confDefault[]',
      'confMode[]',
      'confDescription[]',
      'confType[]',
      'confDisplay[]',
      'confRequired[]',
      'confMask[]',
      'confValue[]',
    ]) {
      expect(valuesOf(form, key), `missing ${key}`).toHaveLength(1);
    }
  });

  it('includes the csrf token', () => {
    const form = buildAdoptForm(data());

    expect(valuesOf(form, 'csrf_token')).toEqual(['tok123']);
  });

  it('omits the csrf field entirely when there is no token', () => {
    vi.mocked(getCsrfToken).mockReturnValue('');
    const form = buildAdoptForm(data());

    expect(valuesOf(form, 'csrf_token')).toEqual([]);
  });

  it('does not ask for a dry run by default', () => {
    const form = buildAdoptForm(data());

    expect(valuesOf(form, 'dryRun')).toEqual([]);
  });

  it('asks for a dry run when requested', () => {
    const form = buildAdoptForm(data(), true);

    expect(valuesOf(form, 'dryRun')).toEqual(['true']);
  });

  it('sends no config arrays when the container has no mappings', () => {
    const form = buildAdoptForm(data({ configs: [] }));

    expect(valuesOf(form, 'confType[]')).toEqual([]);
    expect(valuesOf(form, 'contName')).toEqual(['Adopt2']);
  });
});
