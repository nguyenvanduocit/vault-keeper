/**
 * Synthetic field resolvers (spec §5.2).
 *
 * A synthetic field name begins with `$` and resolves to document
 * metadata rather than a frontmatter key. `applyFieldSchema` consults
 * this map when it encounters a `$`-prefixed field in the template's
 * `fields:` schema.
 *
 * Each resolver takes `docMeta` (`{ repoRelativePath, fileExists? }`)
 * and returns the synthetic value, or `undefined` if the resolver
 * can't produce one for this document.
 */

export const SYNTHETIC_RESOLVERS = {
  $path: (docMeta) => docMeta.repoRelativePath,
};
