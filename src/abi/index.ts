// Contract ABIs Perch needs, copied from @somnia-chain/markets-sdk 0.32.1
// (MIT licensed, see THIRD_PARTY_NOTICES.md). Perch runs on Cloudflare Workers,
// where the SDK's WebSocket-only client cannot run, so it calls the same
// contracts directly with viem over HTTP.

import { parseAbi, type Abi } from "viem";
import errorsJson from "./errors.json";

/** Every named revert the dreamDEX contracts can raise, so failures read as e.g. `ImmediateOrCancelNoFill`. */
export const contractErrorsAbi = errorsJson as unknown as Abi;

export const perpPoolReadAbi = parseAbi([
  "function tryGetMarkPrice() view returns (bool ok, uint256 price)",
  "function getIndexPrice() view returns (uint256 price, uint256 updatedAt)",
  "function getCurrentFundingRate() view returns (int256)",
  "function getOpenInterest() view returns (uint256 openInterest)",
  "function getFundingParameters() view returns ((uint256 fundingCalculationWindowSec, uint256 fundingSettlementIntervalSec, int256 interestRatePerWindow, uint256 maxFundingRatePerWindow, uint256 dampener, uint256 emaSmoothingAlpha, uint256 maxOracleStalenessSec))",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
]);

export const marginBankReadAbi = parseAbi([
  "function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountState(address account) view returns ((int256 unlockedCollateralBalance, uint256 lockedCollateral, address[] activePerpPools))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
  "function tryGetAccountEquity(address account) view returns (bool ok, int256 equity)",
  "function getMarginStatus(address account) view returns (uint8)",
]);

/**
 * The calls a linked bot key may make for its account. The dreamDEX app's
 * "Link a bot" grants exactly these on every perp pool. Same signatures as
 * the official dreamdex-bot-kit (packages/perp-core/src/operator.ts).
 */
export const operatorAbi = [
  ...parseAbi([
    "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function cancelOrderFor(address owner, uint128 orderId)",
    "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  ]),
  ...(errorsJson as unknown as Abi),
] as const;

export const PLACE_ORDER_FOR_SELECTOR = "0x80054449" as const;
export const CANCEL_ORDER_FOR_SELECTOR = "0xe37b444b" as const;

/** OrderBook order types. MARKET is immediate-or-cancel. */
export const ORDER_TYPE = { LIMIT: 0, FILL_OR_KILL: 1, MARKET: 2, POST_ONLY: 3 } as const;

/** MarginBank account states, in enum order. */
export const MARGIN_STATUS = ["Healthy", "MarginCall", "PartialLiquidation", "CloseOut"] as const;
