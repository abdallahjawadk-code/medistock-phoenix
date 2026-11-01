/** Bundle the real pure client decoder for loopback wire acceptance. All browser
 * Supabase I/O is replaced by a throwing boundary; real Auth remains in caller. */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function buildVerifiedSourceClientModel(output) {
  await build({ stdin: { contents: `export {decodeSourceCapabilities,decodeSourcePage,decodeVerifiedMembership,decodeVerifiedReceipt,freezeVerifiedIntent}
    from './src/features/central-needs/annual-catalog/verified-source.contract.ts';`, resolveDir: process.cwd() },
  outfile: output, bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent', alias: { '@': resolve('src') },
  plugins: [{ name: 'pure-client-decoder-no-io', setup(builder) {
    // Match the resolved file, including relative imports such as ../client.
    builder.onLoad({ filter: /[\\/]shared[\\/]supabase[\\/]client\.ts$/ }, () => ({ loader: 'js', contents: `export const supabaseConfigured = true;
      export const supabase = new Proxy({}, {get(){throw new Error('pure decoder attempted client I/O');}});` }));
  } }] });
  return import(pathToFileURL(output).href);
}
