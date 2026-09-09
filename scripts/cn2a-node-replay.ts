/**
 * CN-2A verification tooling — NOT shipped to the app bundle. Reads a file
 * from disk (workbook or ZIP archive) and runs it through the Node 22
 * authoritative replay adapter, printing the JSON result to stdout.
 *
 * Usage: node --experimental-strip-types scripts/cn2a-node-replay.ts <path> [--archive]
 *
 * Never logs workbook cell contents to any location other than stdout of
 * this explicitly-invoked local verification run; the real corpus is never
 * committed to the repository regardless of what this script prints.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { replayArchive, replayWorkbook } from '../src/features/central-needs/import/node-replay.ts';

const [, , path, mode] = process.argv;
if (!path) {
  console.error('Usage: cn2a-node-replay.ts <path> [--archive]');
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(path));
const name = basename(path);

const result = mode === '--archive' ? await replayArchive(bytes, name) : await replayWorkbook(bytes, name);
process.stdout.write(JSON.stringify(result));
