import { defineField, defineType } from 'sanity'

export const pageType = defineType({
  name: 'page',
    title: 'Page',
      type: 'document',
        fields: [
            defineField({ name: 'title', title: 'Title', type: 'string', validation: (r) => r.required() }),
                defineField({ name: 'slug', title: 'Slug', type: 'slug', options: { source: 'title' } }),
                    defineField({ name: 'seoTitle', title: 'SEO Title', type: 'string' }),
                        defineField({ name: 'seoDescription', title: 'SEO Description', type: 'text' }),
                            defineField({ name: 'heroHeadline', title: 'Hero Headline', type: 'string' }),
                                defineField({ name: 'heroSubheadline', title: 'Hero Subheadline', type: 'text' }),
                                    defineField({ name: 'heroImage', title: 'Hero Image', type: 'image', options: { hotspot: true } }),
                                        defineField({ name: 'body', title: 'Body Content', type: 'array', of: [{ type: 'block' }, { type: 'image' }] }),
                                            defineField({ name: 'publishedAt', title: 'Published At', type: 'datetime' }),
                                                defineField({ name: 'hidden', title: 'Hidden', type: 'boolean', initialValue: false }),
                                                  ],
                                                    preview: { select: { title: 'title', subtitle: 'slug.current' } },
                                                    })
