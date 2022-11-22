import "@imstar15/api-augment";
import _ from 'lodash';
import confirm from '@inquirer/confirm';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import BN from 'bn.js';

import turingHelper from "./common/turingHelper";
import mangataHelper from "./common/mangataHelper";
import Account from './common/account';
import { env, tokenConfig } from "./common/constants";

const { TURING_ENDPOINT, MANGATA_ENDPOINT } = env;

console.log(env);

// const OAK_SOV_ACCOUNT = "68kxzikS2WZNkYSPWdYouqH5sEZujecVCy3TFt9xHWB5MDG5";
const MGR_LIQUIDITY_VAULT = "5EYCAe5ijiYetuT4xrRZx2vbVopfJjhvfsZ4546K1Mmdexb1";

/*** Main entrance of the program */
async function main() {
  await cryptoWaitReady();

  console.log("Initializing APIs of both chains ...");
  await turingHelper.initialize(TURING_ENDPOINT);
  await mangataHelper.initialize(MANGATA_ENDPOINT);

  console.log("Reading token and balance of Alice and Bob accounts ...");
  const alice = new Account("Alice");
  await alice.init();
  alice.print();

  const mangataAddress = alice.assets[1].address;

  console.log("Minting tokens for Alice on Maganta if balance is zero ...");
  for (let i = 0; i < alice.assets[1].tokens.length; i += 1) {
    const { symbol, balance } = alice.assets[1].tokens[i];

    if (balance.isZero()) {
      console.log(`[Alice] ${symbol} balance on Mangata is zero; minting ${symbol} with sudo ...`);
      // Because sending extrinsic in parallel will cause repeated nonce errors
      // we need to wait for the previous extrinsic to be finalized before sending the extrinsic.
      await mangataHelper.mintToken(mangataAddress, symbol, alice.keyring);
    }
  }

  // If there is no proxy, add proxy.
  const proxiesResponse = await mangataHelper.api.query.proxy.proxies(mangataAddress);
  const [proxies] = proxiesResponse.toJSON()[0];
  console.log('proxies: ', proxies);

  if (_.isEmpty(proxies)) {
    await mangataHelper.addProxy(alice.assets[1].proxyAddress, alice.keyring);
  }

  const answerPool = await confirm({ message: '\nAccount setup is completed. Press ENTRE to set up pools.', default: true });

  if (answerPool) {
    // Get current pools available
    const pools = await mangataHelper.getPools();
    console.log('Existing pools: ', pools);

    const poolFound = _.find(pools, (pool) => {
      return pool.firstTokenId === mangataHelper.getTokenIdBySymbol("MGR") && pool.secondTokenId === mangataHelper.getTokenIdBySymbol("TUR");
    });

    if (_.isUndefined(poolFound)) {
      console.log(`No MGR-TUR pool found; creating a MGR-TUR pool with Alice ...`);
      await mangataHelper.createPool(
        "MGR",
        "TUR",
        new BN('10000').mul(new BN(tokenConfig.MGR.decimal)),  // 10000 MGR (MGR is 18 decimals)
        new BN('100').mul(new BN(tokenConfig.TUR.decimal)),    // 100 TUR (TUR is 12 decimals)
        alice.keyring,
      );

      // Update assets
      await mangataHelper.updateAssets();

      // Promote pool
      console.log(`Promote the pool to activate liquidity rewarding ...`);
      await mangataHelper.promotePool('MGR-TUR', alice.keyring);

      console.log("Providing liquidity to generate rewards...");
      await mangataHelper.provideLiquidity(alice.keyring, "MGR-TUR", "MGR", new BN('10000000000000000000000'));
      await mangataHelper.provideLiquidity(alice.keyring, "MGR-TUR", "TUR", new BN('100000000000000'));

      console.log("Seeding liquidity vault with funds...");
      await mangataHelper.mintToken(MGR_LIQUIDITY_VAULT, "MGR", alice.keyring, new BN('1000000000000000000000'));
    } else {
      console.log(`An existing MGR-TUR pool found; skip pool creation ...`);
    }
  }

  console.log('Transfering TUR token from Mangata to Turing to pay fees ...');
  // Tranfer TUR to Turing Network to fund user’s account
  await mangataHelper.transferTur(new BN('10').mul(new BN(tokenConfig.TUR.decimal)), alice.keyring.address, alice.keyring);

  const answerTestPool = await confirm({ message: '\nPool setup is completed. Press ENTRE to test the pool and teleport asset.', default: true });
  if (answerTestPool) {
    console.log('Swap MGX for TUR to test the pool ...');
    await mangataHelper.swap("MGR", "TUR", alice.keyring);

    // TODO: how do we prove that the liquidity owner earned fee? According to Marian, "the user that provided the liquidity should be eligible for some rewards after some time"
    //       how to check the amount of fee to claim?
    //       test claim extrinsic

    // Check reward amont
    const rewardAmount = await mangataHelper.calculateRewardsAmount(mangataAddress, 'MGR-TUR');
    console.log('rewardAmount: ', rewardAmount);
  }
}

main().catch(console.error).finally(() => process.exit());