/* eslint-disable @typescript-eslint/naming-convention */
import {
  Web3Function,
  Web3FunctionContext,
} from "@gelatonetwork/web3-functions-sdk";
import { Contract } from "ethers";

import { EvmPriceServiceConnection } from "@pythnetwork/pyth-evm-js";
import { IPyth } from "../../typechain";
import PythAbi from "@pythnetwork/pyth-sdk-solidity/abis/IPyth.json";
import {
  PythConfig,
  fetchPythConfigIfNecessary,
  getCurrentPrices,
  getLastOnChainPrices,
} from "./pythUtils";

/*
We limited the debug logs. At the time of writing, web3 functions have a limit of 1000 characters in their debug logs.
*/

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { storage, secrets, multiChainProvider } = context;

  const provider = multiChainProvider.default();

  // Refresh/retrieve config from storage
  const gistId = (await secrets.get("GIST_ID")) as string;

  let pythConfig: PythConfig | undefined;
  try {
    pythConfig = await fetchPythConfigIfNecessary(storage, gistId);
  } catch (err) {
    const error = err as Error;
    return {
      canExec: false,
      message: `Error fetching gist: ${error.message}`,
    };
  }

  const debug = pythConfig.debug;

  // if (debug) {
  //   console.debug(`pythConfig: ${JSON.stringify(pythConfig)}`);
  // }

  const {
    pythNetworkAddress,
    priceServiceEndpoint,
    validTimePeriodSeconds,
    deviationThresholdBps,
    priceIds,
  } = pythConfig;

  const pythContract = new Contract(
    pythNetworkAddress,
    PythAbi,
    provider
  ) as IPyth;

  // Get Pyth price data
  const connection = new EvmPriceServiceConnection(priceServiceEndpoint);
  // if (debug) {
  //   console.debug(`fetching current prices for priceIds: ${priceIds}`);
  // }
  const currentPrices = await getCurrentPrices(priceIds, connection, debug);
  if (currentPrices === undefined) {
    return {
      canExec: false,
      message: `Error fetching latest priceFeeds for priceIds: ${priceIds}`,
    };
  }

  if (currentPrices.size != priceIds.length) {
    const missingPriceIds = priceIds.filter((p) => !currentPrices.has(p));
    console.error(
      `Missing latest price feed info for ${JSON.stringify(missingPriceIds)}`
    );
    return { canExec: false, message: "Not all prices available" };
  }

  const lastPrices = await getLastOnChainPrices(priceIds, pythContract);
  // if (debug) {
  //   console.debug(
  //     `
  //       currentPrices: ${JSON.stringify([...currentPrices.entries()])}
  //       lastPrices: ${JSON.stringify([...lastPrices.entries()])}
  //     `
  //   );
  // }

  // Example simulation results for priceFeedNeedsUpdate:

  // Scenario 1: Price deviation exceeds threshold
  // Input:
  //   lastPrice: { price: "1000000", expo: -6, publishTime: 1677721600 }  
  //   currentPrice: { price: "1200000", expo: -6, publishTime: 1677725200 }
  //   deviationThresholdBps: 100 (1%)
  // Output:
  //   priceDiff: 200000n (20%)
  //   priceExceedsDiff: true
  //   priceIsStale: false
  //   returns: true

  // Scenario 2: Price is stale
  // Input:  
  //   priceId: "0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b"
  //   lastPrice: { price: "30000000000", expo: -9, publishTime: 1677721600 }
  //   currentPrice: { price: "30100000000", expo: -9, publishTime: 1677728800 } 
  //   validTimePeriodSeconds: 3600 (1 hour)
  // Output:
  //   priceDiff: 3333n (0.33%)
  //   priceExceedsDiff: false  
  //   priceIsStale: true
  //   returns: true

  // Scenario 3: No update needed
  // Input:
  //   priceId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
  //   lastPrice: { price: "50000000", expo: -6, publishTime: 1677721600 }
  //   currentPrice: { price: "50200000", expo: -6, publishTime: 1677723400 }
  // Output:  
  //   priceDiff: 4000n (0.4%)
  //   priceExceedsDiff: false
  //   priceIsStale: false
  //   returns: false

  const priceFeedNeedsUpdate = (priceId: string): boolean => {
    const lastPrice = lastPrices.get(priceId);
    // console.debug(`lastPrice: ${JSON.stringify(lastPrice)}`);
    const currentPrice = currentPrices.get(priceId);
    // If the price is not available on chain, we need to update it
    if (!lastPrice || !currentPrice) return true;
    let priceDiff = BigInt(lastPrice.price) - BigInt(currentPrice.price);
    priceDiff = priceDiff < 0 ? -priceDiff : priceDiff;
    priceDiff /= BigInt(lastPrice.price);
    const priceExceedsDiff = priceDiff >= deviationThresholdBps / 10000;
    const priceIsStale =
      currentPrice.publishTime - lastPrice.publishTime > validTimePeriodSeconds;
    if (priceIsStale || priceExceedsDiff) {
      if (debug) {
        console.debug(`
          priceId: ${priceId}
          priceDiff: ${priceDiff}
          priceExceedsDiff: ${priceExceedsDiff}
          priceIsStale: ${priceIsStale}
          lastPrice: ${lastPrice.price}
          currentPrice: ${currentPrice.price}
          lastPriceTime: ${lastPrice.publishTime}
          currentPriceTime: ${currentPrice.publishTime}
        `);
      }
      return true;
    }
    return false;
  };

  let priceIdsToUpdate: string[] = [];
  for (const priceId of currentPrices.keys()) {
    if (
      lastPrices.get(priceId) === undefined ||
      priceFeedNeedsUpdate(priceId)
    ) {
      priceIdsToUpdate = [...currentPrices.keys()];
      break;
    }
  }

  if (priceIdsToUpdate.length > 0) {
    // if (debug) {
    //   console.debug(`n of PriceIds: `, priceIdsToUpdate.length);
    // }

    const publishTimes = priceIdsToUpdate.map(
      (priceId) => currentPrices.get(priceId)!.publishTime
    );
    const updatePriceData = await connection.getPriceFeedsUpdateData(
      priceIdsToUpdate
    );
    const fee = (await pythContract.getUpdateFee(updatePriceData)).toString();
    const callData = await pythContract.interface.encodeFunctionData(
      "updatePriceFeedsIfNecessary",
      [updatePriceData, priceIdsToUpdate, publishTimes]
    );
    return {
      canExec: true,
      callData: [
        {
          to: pythNetworkAddress,
          data: callData,
          value: fee,
        },
      ],
    };
  } else {
    return {
      canExec: false,
      message: `No conditions met for price initialization or update for priceIds: ${priceIds}`,
    };
  }
});
