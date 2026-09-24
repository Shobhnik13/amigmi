import { loadAuth, loadState, saveState } from './lib/state';
import { collect, warnUnpriced } from './lib/collect';
import { postSync } from './lib/sync';

async function run() {
  const auth = loadAuth();
  if (!auth) {
    console.error('No auth found. Run `bunx amigmi init`');
    process.exit(1);
  }

  const { records, state, unpriced } = await collect(loadState());

  // Push before persisting: if the upload fails we keep the old cursors and
  // retry the same range next run rather than losing it.
  const result = await postSync(auth.token, auth.api_url, records);

  await saveState({ ...state, last_sync_at: new Date().toISOString() });

  if (records.length === 0) {
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
