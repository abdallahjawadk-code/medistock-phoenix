/**
 * CN-2A verification tooling — Node side of the ZIP dual-runtime parity check.
 * Parses the committed synthetic ZIP fixture through the Node 22 replay
 * adapter and prints the ArchiveParseResult JSON to stdout.
 */
import { readFileSync } from 'node:fs';
import { replayArchive } from '../src/features/central-needs/import/node-replay.ts';

const path = 'src/features/central-needs/import/__tests__/fixtures/synthetic-archive.zip';
const bytes = new Uint8Array(readFileSync(path));
const result = await replayArchive(bytes, 'synthetic-archive.zip');
process.stdout.write(JSON.stringify(result));
