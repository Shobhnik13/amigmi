import { describe, expect, test } from 'bun:test';
import { needsMigration, STATE_VERSION } from '../lib/migration';

describe('needsMigration', () => {
  test('a state file written before versioning needs correcting', () => {
    // Everything synced by the parsers that counted log records rather than
    // billed responses. No schema_version field was written back then.
    expect(needsMigration({ cursors: {}, last_sync_at: '2026-09-01T00:00:00Z' })).toBe(true);
  });

  test('a fresh install needs no correcting once it records the version', () => {
    expect(needsMigration({})).toBe(true);
    expect(needsMigration({ schema_version: STATE_VERSION })).toBe(false);
  });

  test('an explicit version behind the current one still migrates', () => {
    expect(needsMigration({ schema_version: STATE_VERSION - 1 })).toBe(true);
  });

  test('a state file from a newer client is left alone', () => {
    // Downgrading should not re-push absolute totals over newer data.
    expect(needsMigration({ schema_version: STATE_VERSION + 1 })).toBe(false);
  });
});
