import { defineField, defineType } from 'sanity'

export const investmentDealType = defineType({
  name: 'investmentDeal',
    title: 'Investment Deal',
      type: 'document',
        fields: [
            defineField({ name: 'title', title: 'Deal Title', type: 'string', validation: (r) => r.required() }),
                defineField({ name: 'slug', title: 'Slug', type: 'slug', options: { source: 'title' } }),
                    defineField({ name: 'category', title: 'Category', type: 'string', options: { list: ['Real Estate', 'Tech', 'Crypto', 'Equities', 'Alternative', 'Other'] } }),
                        defineField({ name: 'status', title: 'Status', type: 'string', options: { list: ['open', 'closed', 'coming-soon', 'fully-funded'] }, initialValue: 'coming-soon' }),
                            defineField({ name: 'summary', title: 'Summary', type: 'text' }),
                                defineField({ name: 'body', title: 'Full Details', type: 'array', of: [{ type: 'block' }, { type: 'image' }] }),
                                    defineField({ name: 'heroImage', title: 'Hero Image', type: 'image', options: { hotspot: true } }),
                                        defineField({ name: 'minInvestment', title: 'Min Investment (USD)', type: 'number' }),
                                            defineField({ name: 'targetReturn', title: 'Target Return (%)', type: 'string' }),
                                                defineField({ name: 'timeline', title: 'Timeline', type: 'string' }),
                                                    defineField({ name: 'requiredTier', title: 'Required Tier', type: 'reference', to: [{ type: 'membershipTier' }] }),
                                                        defineField({ name: 'publishedAt', title: 'Published At', type: 'datetime' }),
                                                            defineField({ name: 'featured', title: 'Featured', type: 'boolean', initialValue: false }),
                                                              ],
                                                                preview: { select: { title: 'title', subtitle: 'status', media: 'heroImage' } },
                                                                })
