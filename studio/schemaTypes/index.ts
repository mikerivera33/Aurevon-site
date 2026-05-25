import { type SchemaTypeDefinition } from 'sanity'
import { membershipTierType } from './membershipTierType'
import { blogPostType } from './blogPostType'
import { teamMemberType } from './teamMemberType'
import { testimonialType } from './testimonialType'
import { siteSettingsType } from './siteSettingsType'
import { investmentDealType } from './investmentDealType'
import { pageType } from './pageType'

export const schemaTypes: SchemaTypeDefinition[] = [
  membershipTierType,
    blogPostType,
      teamMemberType,
        testimonialType,
          siteSettingsType,
            investmentDealType,
              pageType,
              ]
