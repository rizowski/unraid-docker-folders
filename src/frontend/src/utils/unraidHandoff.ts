/**
 * Hand a container over to Unraid's own container manager.
 *
 * Unraid recreates a container and stamps the net.unraid.docker.* labels on it
 * when its /Docker/UpdateContainer endpoint receives a POST (CreateDocker.php:127
 * — `if (isset($_POST['contName']))`). It writes the dockerMan template itself
 * from that same POST, so this plugin never touches templates-user/ and never
 * runs `docker rm`.
 *
 * The greyed-out Apply button on Unraid's edit form is client-side JavaScript on
 * that form. We never render it, so it never applies here.
 */

import { getCsrfToken } from '@/utils/csrf';

const UPDATE_CONTAINER_URL = '/Docker/UpdateContainer';

/** One <Config> row. Attribute names match Unraid's XML exactly. */
export interface AdoptConfig {
  Name: string;
  Target: string;
  Default: string;
  Mode: string;
  Description: string;
  Type: string;
  Display: string;
  Required: string;
  Mask: string;
  Value: string;
}

export interface AdoptFields {
  /** cont* scalars. Every key is sent even when empty — see below. */
  fields: Record<string, string>;
  configs: AdoptConfig[];
  /** Settings that could not be expressed, for the preview to warn about. */
  unmapped: string[];
  /** False when the image could not be read, so the variable list is noisy. */
  imageEnvKnown: boolean;
  /** False when Unraid will pass ports as variables rather than publishing them. */
  portsPublished: boolean;
  /** bridge, macvlan, ipvlan, host — '' when it could not be determined. */
  networkDriver: string;
  managed: string | null;
}

/** The nine parallel arrays, in the order postToXML reads them. */
const CONFIG_KEYS: (keyof AdoptConfig)[] = [
  'Name',
  'Target',
  'Default',
  'Mode',
  'Description',
  'Type',
  'Display',
  'Required',
  'Mask',
  'Value',
];

function hidden(name: string, value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = value;
  return input;
}

/**
 * Build the form Unraid expects. Exported separately from the submit so it can
 * be asserted on without triggering a navigation.
 */
export function buildAdoptForm(data: AdoptFields, dryRun = false): HTMLFormElement {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = UPDATE_CONTAINER_URL;
  // index.html sets <base target="_parent">, but say it explicitly: this must
  // navigate the Unraid page around the iframe, never the iframe itself.
  form.target = '_parent';
  form.style.display = 'none';

  // postToXML reads most cont* keys without a null-coalesce, so an omitted key
  // is a PHP warning on Unraid's side rather than a harmless default. Send them
  // all, empty ones included.
  for (const [name, value] of Object.entries(data.fields)) {
    form.appendChild(hidden(name, value));
  }

  // Tells Unraid this replaces a container that already exists, rather than
  // creating a new one alongside it.
  form.appendChild(hidden('existingContainer', data.fields.contName ?? ''));

  // Ten parallel arrays; entry N of each describes one mapping. Appended per
  // config rather than per key so the rows cannot drift out of alignment.
  for (const config of data.configs) {
    for (const key of CONFIG_KEYS) {
      form.appendChild(hidden(`conf${key}[]`, config[key] ?? ''));
    }
  }

  if (dryRun) {
    // Unraid prints the XML and the docker command, then stops. Nothing is
    // removed, recreated, or written.
    form.appendChild(hidden('dryRun', 'true'));
  }

  const token = getCsrfToken();
  if (token) {
    form.appendChild(hidden('csrf_token', token));
  }

  return form;
}

/**
 * Submit the handoff. Unraid takes over the page and shows its own progress log.
 */
export function submitAdopt(data: AdoptFields, dryRun = false): void {
  const form = buildAdoptForm(data, dryRun);
  document.body.appendChild(form);
  form.submit();
}
