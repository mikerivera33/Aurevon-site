/**
 * tiers.getNextSerial — serials come from the atomic Postgres counter
 * (db.nextSerial → rpc next_serial), formatted PREFIX_NNN. While the Airtable
 * bridge is on, the number must land past the Airtable count so a serial is
 * never reused before the old rows are imported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({ nextSerial: vi.fn() }));
vi.mock('../airtable-import.js', () => ({
  airtableImportEnabled: vi.fn(() => false),
  countAirtableMintsByPrefix: vi.fn(),
}));

import { getNextSerial } from '../tiers.js';
import * as db from '../db.js';
import * as airtable from '../airtable-import.js';

const SAVED = { ...process.env };

beforeEach(() => {
  vi.mocked(db.nextSerial).mockReset();
  vi.mocked(airtable.airtableImportEnabled).mockReset().mockReturnValue(false);
  vi.mocked(airtable.countAirtableMintsByPrefix).mockReset();
});
afterEach(() => { process.env = { ...SAVED }; });

describe('getNextSerial', () => {
  it('formats the reserved number: rpc 7 → EMBER_007', async () => {
    db.nextSerial.mockResolvedValueOnce(7);
    await expect(getNextSerial('EMBER')).resolves.toBe('EMBER_007');
    expect(db.nextSerial).toHaveBeenCalledWith('EMBER');
    expect(db.nextSerial).toHaveBeenCalledTimes(1);
    expect(airtable.countAirtableMintsByPrefix).not.toHaveBeenCalled();
  });

  it('with the Airtable bridge on and 10 Airtable mints, reserves past 10', async () => {
    airtable.airtableImportEnabled.mockReturnValue(true);
    airtable.countAirtableMintsByPrefix.mockResolvedValue(10);
    let n = 0;
    db.nextSerial.mockImplementation(async () => ++n);
    const serial = await getNextSerial('INSIDER');
    expect(Number(serial.split('_')[1])).toBeGreaterThan(10);
    expect(serial).toBe('INSIDER_011');
    expect(airtable.countAirtableMintsByPrefix).toHaveBeenCalledWith('INSIDER');
  });

  it('does not re-reserve when the counter is already past the Airtable count', async () => {
    airtable.airtableImportEnabled.mockReturnValue(true);
    airtable.countAirtableMintsByPrefix.mockResolvedValue(10);
    db.nextSerial.mockResolvedValueOnce(42);
    await expect(getNextSerial('GENESIS')).resolves.toBe('GENESIS_042');
    expect(db.nextSerial).toHaveBeenCalledTimes(1);
  });

  it('an Airtable count failure falls back to the counter value', async () => {
    airtable.airtableImportEnabled.mockReturnValue(true);
    airtable.countAirtableMintsByPrefix.mockRejectedValue(new Error('403'));
    db.nextSerial.mockResolvedValueOnce(3);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getNextSerial('CHROME')).resolves.toBe('CHROME_003');
    spy.mockRestore();
  });

  it('gives up (throws) after 50 extra reservations instead of looping forever', async () => {
    airtable.airtableImportEnabled.mockReturnValue(true);
    airtable.countAirtableMintsByPrefix.mockResolvedValue(1000);
    db.nextSerial.mockResolvedValue(1);
    await expect(getNextSerial('OBSIDIAN')).rejects.toThrow(/after 50/);
    expect(db.nextSerial).toHaveBeenCalledTimes(51);
  });
});
