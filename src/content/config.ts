import { defineCollection, z } from 'astro:content';

const guides = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    icon: z.string(),
    order: z.number().default(99),
    open: z.boolean().default(false),
  }),
});

export const collections = { guides };
