import { defineField, defineType } from 'sanity'

export const membershipTierType = defineType({
  name: 'membershipTier',
    title: 'Membership Tier',
      type: 'document',
        fields: [
            defineField({ name: 'name', title: 'Tier Name', type: 'string', validation: (r) => r.required() }),
                defineField({ name: 'slug', title: 'Slug', type: 'slug', options: { source: 'name' } }),
                    defineField({ name: 'price', title: 'Price (USD)', type: 'number' }),
                        defineField({ name: 'billingType', title: 'Billing Type', type: 'string', options: { list: ['one-time', 'monthly', 'annual'] } }),
                            defineField({ name: 'description', title: 'Description', type: 'text' }),
                                defineField({ name: 'features', title: 'Features', type: 'array', of: [{ type: 'string' }] }),
                                    defineField({ name: 'badge', title: 'Badge Image', type: 'image', options: { hotspot: true } }),
                                        defineField({ name: 'stripeProductId', title: 'Stripe Product ID', type: 'string' }),
                                            defineField({ name: 'crossmintTemplateId', title: 'Crossmint Template ID', type: 'string' }),
                                                defineField({ name: 'discordRoleId', title: 'Discord Role ID', type: 'string' }),
                                                    defineField({ name: 'isActive', title: 'Active', type: 'boolean', initialValue: true }),
                                                        defineField({ name: 'order', title: 'Display Order', type: 'number' }),
                                                            defineField({ name: 'highlighted', title: 'Featured', type: 'boolean', initialValue: false }),
                                                                defineField({ name: 'color', title: 'Accent Color (hex)', type: 'string' }),
                                                                  ],
                                                                    preview: {
                                                                        select: { title: 'name', subtitle: 'price' },
                                                                            prepare({ title, subtitle }) { return { title, subtitle: subtitle ? `$${subtitle}` : '' } },
                                                                              },
                                                                              })
