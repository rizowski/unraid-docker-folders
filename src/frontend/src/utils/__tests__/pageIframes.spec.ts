// The Unraid pages are PHP and HTML, which vitest cannot render, so this reads
// their source. The check guards one rule: a plugin iframe carries
// color-scheme:normal. A theme that sets color-scheme:dark on <html> (Neoraid
// at night) is inherited by the frame, and a frame whose scheme differs from
// its document's gets an opaque white canvas, which hid the widget's text.
import { describe, it, expect } from 'vitest';
import DASHBOARD from '../../../../backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/DockerFoldersDashboard.page?raw';
import FOLDERS from '../../../../backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/Folders.page?raw';
import INJECT from '../../../../backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/DockerFoldersInject.page?raw';
import SETTINGS from '../../../../backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/DockerFolders.page?raw';

function iframeTags(source: string): string[] {
  return source.match(/<iframe\b[^>]*>/g) ?? [];
}

describe('plugin page iframes', () => {
  it.each([
    ['DockerFoldersDashboard.page', DASHBOARD, 'docker-folders-widget-frame'],
    ['Folders.page', FOLDERS, 'docker-folders-frame'],
  ])('%s: the frame has color-scheme:normal in its style', (_name, source, id) => {
    const tags = iframeTags(source).filter((tag) => tag.includes(`id="${id}"`));
    expect(tags).toHaveLength(1);
    expect(tags[0].replace(/\s+/g, '')).toMatch(/style="[^"]*color-scheme:normal;/);
  });

  it('no other page of the plugin embeds a frame without the rule', () => {
    for (const source of [INJECT, SETTINGS]) {
      for (const tag of iframeTags(source)) {
        expect(tag.replace(/\s+/g, '')).toMatch(/color-scheme:normal/);
      }
    }
  });
});
