import { onUnmounted } from 'vue';

/**
 * Parent-window modal system.
 *
 * The Vue app runs inside an iframe on Unraid. In-iframe modals get clipped
 * when the parent page scrolls. This composable lets a Vue component describe
 * a modal declaratively and have it rendered in the parent document via
 * postMessage to `DockerFoldersMain.page`.
 *
 * Messages (iframe -> parent):
 *   { type: 'docker-folders-modal', open: true, modal: ModalDescriptor }
 *   { type: 'docker-folders-modal', open: false, id }
 *   { type: 'docker-folders-modal-update', id, patch }
 *   { type: 'docker-folders-modal-result', id, success, error? }
 *
 * Messages (parent -> iframe):
 *   { type: 'docker-folders-modal-action', id, actionId, values }
 *
 * In dev mode (`window.parent === window`) the composable is a no-op and
 * the component should fall back to its existing in-iframe template via
 * `v-if="!inIframe"`.
 */

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export type ModalFieldBase = { tab?: string };

export type ModalField = ModalFieldBase & (
  | { type: 'html'; id?: string; html: string }
  | {
      type: 'text';
      id?: string;
      text: string;
      variant?: 'default' | 'muted' | 'error' | 'success';
    }
  | {
      type: 'heading';
      id?: string;
      text: string;
    }
  | {
      type: 'input';
      id: string;
      label?: string;
      value: string;
      placeholder?: string;
      inputType?: string;
      required?: boolean;
      pattern?: string;
      autofocus?: boolean;
      suffix?: string;
    }
  | {
      type: 'textarea';
      id: string;
      label?: string;
      value: string;
      placeholder?: string;
      readOnly?: boolean;
      monospace?: boolean;
      fillHeight?: boolean;
      caption?: string;
    }
  | {
      type: 'color';
      id: string;
      label?: string;
      value: string;
      caption?: string;
    }
  | {
      type: 'checkbox-list';
      id: string;
      label?: string;
      caption?: string;
      items: {
        id: string;
        label: string;
        icon?: string;
        state?: string;
        checked: boolean;
      }[];
    }
  | {
      type: 'progress-list';
      id: string;
      items: {
        id: string;
        label: string;
        percent: number;
        status: string;
        state?: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
        sublabel?: string;
      }[];
    }
  | {
      type: 'log';
      id: string;
      content: string;
      caption?: string;
      fillHeight?: boolean;
    }
  | {
      type: 'status';
      id: string;
      message: string;
      variant?: 'info' | 'success' | 'error';
      spinner?: boolean;
    }
  | {
      type: 'select';
      id: string;
      label?: string;
      value: string | number;
      options: { value: string | number; label: string }[];
    }
);

export interface ModalAction {
  id: string;
  label: string;
  variant?: 'primary' | 'danger' | 'default';
  disabledWhenEmpty?: string;
  hidden?: boolean;
}

export interface ModalTab {
  id: string;
  label: string;
}

export interface ModalDescriptor {
  id: string;
  kind: string;
  title: string;
  size?: ModalSize;
  fillHeight?: boolean;
  dismissable?: boolean; // defaults true
  fields: ModalField[];
  actions: ModalAction[];
  tabs?: ModalTab[];
  activeTab?: string;
  // fields may carry an optional `tab` key to scope them to a tab
}

export interface ModalFieldPatch {
  id: string;
  [key: string]: unknown;
}

export interface ModalPatch {
  title?: string;
  fields?: ModalFieldPatch[];
  actions?: ModalAction[];
  activeTab?: string;
  dismissable?: boolean;
}

export interface ModalActionEvent {
  actionId: string;
  values: Record<string, unknown>;
  activeTab?: string;
}

export interface UseParentModalOptions {
  onAction: (event: ModalActionEvent) => void;
}

let counter = 0;
function genId(): string {
  counter += 1;
  return `dfm-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function useParentModal(options: UseParentModalOptions) {
  const inIframe = typeof window !== 'undefined' && window.parent !== window;
  const id = genId();
  let isOpen = false;

  function handleMessage(e: MessageEvent) {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'docker-folders-modal-action') return;
    if (data.id !== id) return;
    options.onAction({
      actionId: data.actionId,
      values: data.values || {},
      activeTab: data.activeTab,
    });
  }

  if (inIframe) {
    window.addEventListener('message', handleMessage);
  }

  function open(descriptor: Omit<ModalDescriptor, 'id'>) {
    if (!inIframe) return;
    isOpen = true;
    window.parent.postMessage(
      {
        type: 'docker-folders-modal',
        open: true,
        modal: { ...descriptor, id },
      },
      '*',
    );
  }

  function update(patch: ModalPatch) {
    if (!inIframe || !isOpen) return;
    window.parent.postMessage(
      {
        type: 'docker-folders-modal-update',
        id,
        patch,
      },
      '*',
    );
  }

  function close() {
    if (!inIframe || !isOpen) return;
    isOpen = false;
    window.parent.postMessage(
      { type: 'docker-folders-modal', open: false, id },
      '*',
    );
  }

  function result(success: boolean, error?: string) {
    if (!inIframe || !isOpen) return;
    window.parent.postMessage(
      {
        type: 'docker-folders-modal-result',
        id,
        success,
        error: error || null,
      },
      '*',
    );
  }

  onUnmounted(() => {
    if (inIframe) {
      window.removeEventListener('message', handleMessage);
      if (isOpen) close();
    }
  });

  return {
    inIframe,
    id,
    open,
    update,
    close,
    result,
  };
}
