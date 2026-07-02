/**
 * REAL end-to-end deposit test against the LIVE backend:
 * the local analyst wallet sends real testnet UCT to the house nametag,
 * then we poll /api/arcade/balance until the live dealer credits it.
 *
 * Run from the repo root:  node scripts/deposit-e2e.mjs
 */
import { SphereAgent, loadEnv, createLogger } from '@bazaar/core';
import path from 'node:path';

const B = 'https://sphere-agent-bazaar-backend.onrender.com';
const AMOUNT = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => {
  try {
    const r = await fetch(`${B}${p}`);
    return JSON.parse(await r.text());
  } catch (e) {
    return { error: String(e) };
  }
};

const env = loadEnv();
const agent = new SphereAgent({
  name: 'analyst',
  nametag: env.analyst.nametag,
  dataDir: path.join(env.dataRoot, 'analyst'),
  network: env.network,
  oracleApiKey: env.oracleApiKey,
  walletApiUrl: env.walletApiUrl,
  mnemonic: env.analyst.mnemonic,
  deviceId: 'bazaar-analyst',
  logger: createLogger('depositqa'),
});

// wait for the new backend (balance endpoint + deposit info)
let lb;
for (let i = 0; i < 40; i++) {
  lb = await j('/api/arcade/leaderboard');
  if (lb.ready && lb.deposit?.to) break;
  console.log(`  …waiting deploy (ready=${lb.ready} deposit=${JSON.stringify(lb.deposit ?? null)})`);
  lb = null;
  await sleep(10000);
}
if (!lb) {
  console.log('deposit-enabled backend not detected');
  process.exit(1);
}
console.log(`live deposit target: ${lb.deposit.to} coin=${lb.deposit.coinId.slice(0, 10)}… decimals=${lb.deposit.decimals}\n`);

await agent.start();
const pubkey = agent.chainPubkey;
console.log(`sender pubkey: ${pubkey.slice(0, 24)}… balance: ${await agent.balanceUct()} UCT`);

const before = await j(`/api/arcade/balance?address=${encodeURIComponent(pubkey)}`);
console.log(`in-house balance before: ${before.balanceUct} UCT`);

console.log(`sending REAL ${AMOUNT} UCT → ${lb.deposit.to} …`);
const tx = await agent.send(lb.deposit.to, AMOUNT, 'arcade-deposit-e2e');
console.log(`transfer sent: id=${tx?.id ?? '?'} delivery=${tx?.deliveryState ?? '?'}`);

let credited = false;
for (let i = 0; i < 40; i++) {
  await sleep(6000);
  const b = await j(`/api/arcade/balance?address=${encodeURIComponent(pubkey)}`);
  process.stdout.write(`  poll ${i}: in-house balance = ${b.balanceUct}\n`);
  if (Number(b.balanceUct) >= Number(before.balanceUct) + AMOUNT) {
    credited = true;
    console.log(`\nCREDITED ✓  ${before.balanceUct} → ${b.balanceUct} UCT`);
    break;
  }
}
if (!credited) console.log('\nNOT credited within the window — check the house receive sweep');

const after = await j('/api/arcade/leaderboard');
const depEvent = (after.houseStats?.feed ?? []).find((e) => e.kind === 'deposit');
console.log(`feed deposit event: ${depEvent ? JSON.stringify(depEvent) : 'none'}`);
await agent.stop();
process.exit(credited ? 0 : 1);
