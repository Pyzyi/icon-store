/**
 * @typedef {{ icon: import('./storage.js').Icon, name: string, filename: string, tags: string[] }} IndexEntry
 */

/**
 * Lower-casing once per write instead of once per entry per query keeps a
 * search over thousands of icons to a plain substring scan.
 * @param {import('./storage.js').Icon[]} icons
 * @returns {IndexEntry[]}
 */
export function buildSearchIndex(icons) {
  return icons.map((icon) => ({
    icon,
    name: icon.name.toLowerCase(),
    filename: icon.filename.toLowerCase(),
    tags: icon.tags,
  }));
}

/**
 * Same semantics as v1: substring match on name, filename or any tag.
 * @param {IndexEntry[]} index
 * @param {string} query
 */
export function search(index, query) {
  const q = query.toLowerCase().trim();
  if (!q) return index.map((e) => e.icon);
  return index
    .filter((e) => e.name.includes(q) || e.filename.includes(q) || e.tags.some((t) => t.includes(q)))
    .map((e) => e.icon);
}
