import { defineField, defineType } from 'sanity'

export const teamMemberType = defineType({
    name: 'teamMember',
    title: 'Team Member',
    type: 'document',
    fields: [
          defineField({ name: 'name', title: 'Full Name', type: 'string', validation: (r) => r.required() }),
          defineField({ name: 'slug', title: 'Slug', type: 'slug', options: { source: 'name' } }),
          defineField({ name: 'role', title: 'Role / Title', type: 'string' }),
          defineField({ name: 'bio', title: 'Bio', type: 'text' }),
          defineField({ name: 'photo', title: 'Photo', type: 'image', options: { hotspot: true } }),
          defineField({ name: 'order', title: 'Display Order', type: 'number' }),
          defineField({ name: 'isActive', title: 'Active', type: 'boolean', initialValue: true }),
        ],
    preview: { select: { title: 'name', subtitle: 'role', media: 'photo' } },
})
