import type { KebabMenuItem } from '@/components/KebabMenu.vue';

/** Alphabetical by the label the user sees, which can change with state. */
export function byLabel(items: KebabMenuItem[]): KebabMenuItem[] {
  return [...items].sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
}
