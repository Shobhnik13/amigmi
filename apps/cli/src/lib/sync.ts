import type { AggregateRecord, SyncMode } from '../types';

const MAX_RETRIES = 3;

export type SyncResponse = {
  ok: boolean;
  records_upserted: number;
  // Echoed back by the server so the client can tell whether a replace was
  // honoured. A server that predates the flag omits it, which the caller must
  // treat as a refusal rather than a success.
  mode?: SyncMode;
};

export type PostOptions = {
  clientVersion?: string;
  mode?: SyncMode;
};

export async function postSync(
  token: string,
  apiUrl: string,
  records: AggregateRecord[],
  options: PostOptions = {},
): Promise<SyncResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);

    try {
      const res = await fetch(`${apiUrl}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          records,
          client_version: options.clientVersion,
          mode: options.mode ?? 'append',
        }),
      });

      if (res.status === 401) throw new Error('KEY_INVALID');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return (await res.json()) as SyncResponse;
    } catch (err) {
      lastError = err as Error;
      if ((err as Error).message === 'KEY_INVALID') throw err;
    }
  }

  throw lastError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
