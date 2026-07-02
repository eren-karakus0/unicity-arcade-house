/**
 * Discover the EXACT shape `payments.receive()` hands to its callback:
 * spin up a throwaway local wallet, send it real UCT from the analyst
 * wallet, and dump everything the receiver sees. Local-only diagnostics.
 */
import { SphereAgent, loadEnv, createLogger } from '@bazaar/core';
import path from 'node:path';

const env = loadEnv();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const probe = new SphereAgent({
  name: 'probe',
  nametag: 'probe-knkchn-qa',
  dataDir: path.join(env.dataRoot, 'probe-qa'),
  network: env.network,
  oracleApiKey: env.oracleApiKey,
  walletApiUrl: env.walletApiUrl,
  deviceId: 'bazaar-probe-qa',
  logger: createLogger('probe'),
});
const analyst = new SphereAgent({
  name: 'analyst',
  nametag: env.analyst.nametag,
  dataDir: path.join(env.dataRoot, 'analyst'),
  network: env.network,
  oracleApiKey: env.oracleApiKey,
  walletApiUrl: env.walletApiUrl,
  mnemonic: env.analyst.mnemonic,
  deviceId: 'bazaar-analyst',
  logger: createLogger('analyst-qa'),
});

await probe.start();
await analyst.start();
console.log(`\nprobe: @${probe.nametag} pub=${probe.chainPubkey?.slice(0, 20)}…`);
console.log(`analyst: pub=${analyst.chainPubkey?.slice(0, 20)}… bal=${await analyst.balanceUct()} UCT\n`);

console.log('sending REAL 2 UCT analyst → probe…');
const tx = await analyst.send(`@${probe.nametag.replace(/^@/, '')}`, 2, 'receive-shape-qa');
console.log(`sent: id=${(tx as { id?: string })?.id} delivery=${(tx as { deliveryState?: string })?.deliveryState}\n`);

for (let i = 0; i < 30; i++) {
  console.log(`--- receive sweep ${i} ---`);
  const seen: unknown[] = [];
  const res = (await probe.receive((t) => seen.push(t))) as { transfers?: unknown[] };
  if (seen.length) console.log('CALLBACK payloads:', JSON.stringify(seen, null, 1).slice(0, 3000));
  if (res?.transfers?.length) console.log('RESULT.transfers:', JSON.stringify(res.transfers, null, 1).slice(0, 3000));
  if (seen.length || res?.transfers?.length) break;
  await sleep(8000);
}
console.log(`\nprobe balance now: ${await probe.balanceUct()} UCT`);
await probe.stop();
await analyst.stop();
process.exit(0);
