import { loadAuth, loadState, saveState } from './lib/state';
import { collect, warnUnpriced } from './lib/collect';
import { needsMigration, STATE_VERSION } from './lib/migration';
import { postSync } from './lib/sync';

async function run() {
  const auth = loadAuth();
  if (!auth) {
    console.error('No auth found. Run `bunx amigmi init`');
    process.exit(1);
  }

  const state = loadState();
  const migrating = needsMigration(state);

  if (migrating) {
    console.log('Correcting previously synced totals (one time, this may take a moment)...');
  }

  // Migrating starts from empty state, so every transcript is rescanned from the
  // beginning and the records are absolute totals rather than the usual delta.
  const { records, state: next, unpriced } = await collect(migrating ? {} : state);
  const mode = migrating ? 'replace' : 'append';

  // Push before persisting: if the upload fails we keep the old cursors and
  // retry the same range next run rather than losing it.
  const result = await postSync(auth.token, auth.api_url, records, { mode });

  // Absolute totals added to what is already stored would double it, so a server
  // that ignores the flag must not be treated as success. Leaving state untouched
  // means the next sync simply tries the migration again.
  if (migrating && records.length > 0 && result.mode !== 'replace') {
    console.error(
      'This version corrects totals that were previously over-counted, which needs\n' +
        'a server that supports replacing them. Nothing was changed. Try again later —\n' +
        'your usage is still recorded locally and will sync once the server is updated.',
    );
    process.exit(1);
  }

  await saveState({
    ...next,
    schema_version: STATE_VERSION,
    last_sync_at: new Date().toISOString(),
  });

  if (migrating) {
    console.log(`Corrected ${result.records_upserted} records`);
  } else if (records.length === 0) {
    console.log('Nothing new to sync');
  } else {
    console.log(`Synced ${result.records_upserted} records`);
  }

  warnUnpriced(unpriced);
}

run().catch((err) => {
  if (err.message === 'KEY_INVALID') {
    console.error('API key is invalid or was regenerated. Run `bunx amigmi init <new-key>` to connect.');
  } else {
    console.error('Sync error:', err.message);
  }
  process.exit(1);
});
