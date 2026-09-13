/**
 * The container search match used by the Folders page and the dashboard widget:
 * a case-insensitive substring of the name or the image.
 */
export function containerMatchesSearch(query: string, name: string, image?: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q) || (image ? image.toLowerCase().includes(q) : false);
}
