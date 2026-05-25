import { defineField, defineType } from 'sanity'

export const testimonialType = defineType({
    name: 'testimonial',
    title: 'Testimonial',
    type: 'document',
    fields: [
          defineField({ name: 'author', title: 'Author Name', type: 'string', validation: (r) => r.required() }),
          defineField({ name: 'role', title: 'Author Role / Tier', type: 'string' }),
          defineField({ name: 'photo', title: 'Author Photo', type: 'image', options: { hotspot: true } }),
          defineField({ name: 'quote', title: 'Quote', type: 'text', validation: (r) => r.required() }),
          defineField({ name: 'rating', title: 'Rating (1-5)', type: 'number' }),
          defineField({ name: 'tier', title: 'Membership Tier', type: 'reference', to: [{ type: 'membershipTier' }] }),
          defineField({ name: 'featured', title: 'Featured', type: 'boolean', initialValue: false }),
          defineField({ name: 'order', title: 'Display Order', type: 'number' }),
        ],
    preview: { select: { title: 'author', subtitle: 'quote' } },
})
