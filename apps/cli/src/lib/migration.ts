import type { State } from '../types';

// 1 — parsers counted one log record as one billed response. Claude Code writes
//     several records per response, so totals pushed before this were roughly
//     2.1x too high and have to be restated rather than added to.
export const STATE_VERSION = 1;

// A state file behind the current version means the totals already on the server
// came from a parser that is now known to be wrong. Rescanning every transcript
// from the start and replacing those rows is the only way to correct them, since
// the transcripts only exist on this machine.
export function needsMigration(state: Partial<State>): boolean {
  return (state.schema_version ?? 0) < STATE_VERSION;
}
