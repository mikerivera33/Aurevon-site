/**
 * Maps NFT type names (as stored in Airtable) to Discord role IDs (from env vars).
 * Role IDs are injected at runtime — never hard-coded.
 */
export const NFT_ROLE_MAP = {
  'Aurevon Insider':            process.env.DISCORD_ROLE_INSIDER,
  'Aurevon Ember':              process.env.DISCORD_ROLE_EMBER,
  'Aurevon Obsidian Executive': process.env.DISCORD_ROLE_OBSIDIAN,
  '001 Genesis':               process.env.DISCORD_ROLE_GENESIS,
  '004 Chrome':                process.env.DISCORD_ROLE_CHROME,
};

/**
 * Resolve a role ID for a given NFT type.
 * @param {string} nftType
 * @returns {string | undefined}
 */
export function getRoleId(nftType) {
  return NFT_ROLE_MAP[nftType];
}
