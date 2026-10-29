export function siteSettings(env = process.env) {
  const origin = new URL(env.DOCS_SITE_URL || 'http://localhost:4321');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('DOCS_SITE_URL must be an HTTP(S) origin without a path, credentials, query or fragment. Use DOCS_BASE_PATH for a path.');
  }
  const rawBase = env.DOCS_BASE_PATH || '/';
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(rawBase) || rawBase.includes('//')) {
    throw new Error('DOCS_BASE_PATH must be an absolute URL path containing letters, digits, underscores or hyphens.');
  }
  const base = '/' + rawBase.split('/').filter(Boolean).join('/') + (rawBase === '/' ? '' : '/');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const indexable = env.DOCS_INDEXABLE === undefined ? !local : env.DOCS_INDEXABLE === 'true';
  if (env.DOCS_INDEXABLE !== undefined && !['true', 'false'].includes(env.DOCS_INDEXABLE)) {
    throw new Error('DOCS_INDEXABLE must be true or false.');
  }
  if (indexable && local) throw new Error('A loopback DOCS_SITE_URL cannot be indexed. Set your real public origin or DOCS_INDEXABLE=false.');
  return {
    site: origin.origin,
    base,
    indexable,
    href: (path = '') => base + path.replace(/^\/+/, ''),
    absolute: (path = '') => origin.origin + base + path.replace(/^\/+/, ''),
  };
}

export const settings = siteSettings();
