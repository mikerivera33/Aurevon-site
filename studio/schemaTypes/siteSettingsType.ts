import { defineField, defineType } from 'sanity'

export const siteSettingsType = defineType({
  name: 'siteSettings',
    title: 'Site Settings',
      type: 'document',
        __experimental_actions: ['update', 'publish'],
          fields: [
              defineField({ name: 'title', title: 'Site Title', type: 'string' }),
                  defineField({ name: 'tagline', title: 'Tagline', type: 'string' }),
                      defineField({ name: 'description', title: 'SEO Description', type: 'text' }),
                          defineField({ name: 'logo', title: 'Logo', type: 'image', options: { hotspot: true } }),
                              defineField({ name: 'ogImage', title: 'Social Share Image', type: 'image', options: { hotspot: true } }),
                                  defineField({ name: 'announcementBar', title: 'Announcement Bar Text', type: 'string' }),
                                      defineField({ name: 'showAnnouncement', title: 'Show Announcement Bar', type: 'boolean', initialValue: false }),
                                          defineField({ name: 'contactEmail', title: 'Contact Email', type: 'string' }),
                                              defineField({ name: 'discordInviteUrl', title: 'Discord Invite URL', type: 'url' }),
                                                  defineField({ name: 'twitterUrl', title: 'Twitter/X URL', type: 'url' }),
                                                      defineField({ name: 'instagramUrl', title: 'Instagram URL', type: 'url' }),
                                                          defineField({ name: 'linkedinUrl', title: 'LinkedIn URL', type: 'url' }),
                                                            ],
                                                            })
