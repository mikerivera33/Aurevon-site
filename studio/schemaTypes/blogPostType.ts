import { defineField, defineType } from 'sanity'

export const blogPostType = defineType({
  name: 'blogPost',
    title: 'Blog Post / Investment Education',
      type: 'document',
        fields: [
            defineField({ name: 'title', title: 'Title', type: 'string', validation: (r) => r.required() }),
                defineField({ name: 'slug', title: 'Slug', type: 'slug', options: { source: 'title' } }),
                    defineField({ name: 'publishedAt', title: 'Published At', type: 'datetime' }),
                        defineField({ name: 'excerpt', title: 'Excerpt', type: 'text' }),
                            defineField({ name: 'mainImage', title: 'Main Image', type: 'image', options: { hotspot: true } }),
                                defineField({ name: 'body', title: 'Body', type: 'array', of: [{ type: 'block' }, { type: 'image' }] }),
                                    defineField({ name: 'categories', title: 'Categories', type: 'array', of: [{ type: 'string' }] }),
                                        defineField({ name: 'memberOnly', title: 'Members Only', type: 'boolean', initialValue: false }),
                                            defineField({ name: 'featured', title: 'Featured', type: 'boolean', initialValue: false }),
                                              ],
                                                preview: { select: { title: 'title', media: 'mainImage' } },
                                                })
