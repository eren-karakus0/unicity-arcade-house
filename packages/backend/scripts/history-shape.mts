/** Dump the probe wallet's history to verify RECEIVED entries carry sender info. */
import { SphereAgent, loadEnv, createLogger } from '@bazaar/core';
import path from 'node:path';

const env = loadEnv();
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
await probe.start();
console.log('\nHISTORY:', JSON.stringify(probe.getHistory(), null, 1).slice(0, 2500));
console.log('\nbalance:', await probe.balanceUct());
await probe.stop();
process.exit(0);
