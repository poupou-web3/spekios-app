import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { settings } from './scripts/site.mjs';
import catalog from './src/data/mcp-tools.json' with {type:'json'};

export default defineConfig({
  site: settings.site,
  base: settings.base,
  trailingSlash: 'always',
  output: 'static',
  integrations: [
    starlight({
      title: 'ScoutQA',
      description: 'URL-first exploratory QA. Understand every action, inspect the evidence, and give coding agents precise feedback.',
      logo: { src: './src/assets/scout-mark.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      components: {
        Head: './src/components/Head.astro',
        PageTitle: './src/components/PageTitle.astro',
        Hero: './src/components/Hero.astro',
        Footer: './src/components/Footer.astro',
      },
      social: [{ icon: 'document', label: 'LLM documentation index', href: settings.absolute('llms.txt') }],
      sidebar: [
        { label: 'Start here', items: [
          { label: 'Overview', slug: 'product/overview' },
          { label: 'Run Scout locally', slug: 'getting-started/local-setup' },
          { label: 'Your first URL', slug: 'getting-started/first-run' },
          { label: 'Connect a model', slug: 'getting-started/models' },
          { label: 'Sign in to a target app', slug: 'getting-started/private-apps' },
        ] },
        { label: 'Understand Scout', items: [{ autogenerate: { directory: 'product' } }], collapsed: true },
        { label: 'Use the workspace', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Agents & LLMs', items: [
          { label: 'Install the agent skill', slug: 'agents/skill' },
          { label: 'Connect with MCP', slug: 'agents/connect' },
          { label: 'Use the CLI', slug: 'agents/cli' },
          { label: 'Identity & private history', slug: 'agents/identity' },
          { label: 'Submit, poll, report, fix', slug: 'agents/workflow' },
          { label: 'Read a finding', slug: 'agents/findings' },
          { label: 'Machine-readable docs', slug: 'agents/machine-readable' },
          { label: 'Tool reference', slug: 'agents/tools' },
          { label: `All ${catalog.tools.length} tools`, items: [{ autogenerate: { directory: 'agents/reference' } }], collapsed: true },
        ] },
        { label: 'HTTP API', items: [{ autogenerate: { directory: 'api' } }], collapsed: true },
        { label: 'Operate & deploy', items: [{ autogenerate: { directory: 'operators' } }], collapsed: true },
      ],
      head: [
        { tag: 'meta', attrs: { name: 'robots', content: settings.indexable ? 'index, follow, max-image-preview:large' : 'noindex, nofollow' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#f4f6ee' } },
      ],
    }),
    sitemap({
      filter: (page) => !page.endsWith('/404/') && !page.endsWith('/404.html'),
    }),
  ],
});
