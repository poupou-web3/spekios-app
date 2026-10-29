import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { z } from 'astro/zod';

export const collections = {
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
  docs: defineCollection({
    loader: docsLoader({ generateId: ({ entry }) => entry.replace(/\.md$/, '') }),
    schema: docsSchema({
      extend: z.object({
        reviewed: z.string().optional(),
        audience: z.string().optional(),
      }),
    }),
  }),
};
