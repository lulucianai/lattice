// Helius RPC adapter — derives a wallet's DLMM positions from on-chain history.
//
// Strategy (wired next): use Helius Enhanced Transactions / parsed history to pull
// the wallet's interactions with the Meteora DLMM program, then fold
// add-liquidity / remove-liquidity / claim-fee events into Position rows.
// Kept behind WalletSource so the worker doesn't care how positions are sourced.

import type { Position } from "@lattice/core";
import type { WalletSource } from "./types.js";

const HELIUS_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "";

/** Meteora DLMM program id (constant, on-chain). */
export const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

export class HeliusClient implements WalletSource {
  async getWalletPositions(wallet: string): Promise<Position[]> {
    if (!RPC_URL) {
      throw new Error("HELIUS_API_KEY not set — cannot query on-chain history.");
    }
    // TODO(wiring): fetch parsed tx history filtered to METEORA_DLMM_PROGRAM,
    // reconstruct open/close per position NFT, compute deposited/fees/pnl.
    // Left unimplemented until the API key is provided so the build stays green.
    void wallet;
    return [];
  }
}
