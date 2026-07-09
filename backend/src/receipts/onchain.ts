import fs from "node:fs";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, Connection, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { config } from "../config.js";

type ChainReceiptInput = {
  poolId: string;
  txlineFixtureId: string;
  finalHomeGoals: number;
  finalAwayGoals: number;
  receiptHash: string;
};

export type ChainReceiptResult =
  | { chainStatus: "disabled" }
  | { chainStatus: "recorded"; signature: string; receiptAddress: string }
  | { chainStatus: "failed"; error: string };

function discriminator(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeString(value: string) {
  const raw = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(raw.length, 0);
  return Buffer.concat([len, raw]);
}

function loadAuthority() {
  if (!config.SOLANA_RECEIPT_KEYPAIR_PATH) throw new Error("SOLANA_RECEIPT_KEYPAIR_PATH is not configured");
  const secret = JSON.parse(fs.readFileSync(config.SOLANA_RECEIPT_KEYPAIR_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function encodeRecordReceipt(input: ChainReceiptInput) {
  const home = Buffer.from([input.finalHomeGoals]);
  const away = Buffer.from([input.finalAwayGoals]);
  const receiptHash = Buffer.from(input.receiptHash, "hex");
  if (receiptHash.length !== 32) throw new Error("receiptHash must be a 32-byte hex string");
  return Buffer.concat([
    discriminator("record_receipt"),
    encodeString(input.poolId),
    encodeString(input.txlineFixtureId),
    home,
    away,
    receiptHash
  ]);
}

export async function recordReceiptOnChain(input: ChainReceiptInput): Promise<ChainReceiptResult> {
  if (!config.RECEIPT_CHAIN_ENABLED) return { chainStatus: "disabled" };

  try {
    if (!config.SOLANA_RPC_URL || !config.SOLANA_RECEIPT_PROGRAM_ID) {
      throw new Error("Solana receipt configuration is incomplete");
    }
    const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
    const programId = new PublicKey(config.SOLANA_RECEIPT_PROGRAM_ID);
    const authority = loadAuthority();
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
    const [receiptPda] = PublicKey.findProgramAddressSync([Buffer.from("receipt"), Buffer.from(input.poolId)], programId);

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: receiptPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: encodeRecordReceipt(input)
    });

    const tx = new Transaction().add(ix);
    const signature = await connection.sendTransaction(tx, [authority], { preflightCommitment: "confirmed" });
    await connection.confirmTransaction(signature, "confirmed");
    return { chainStatus: "recorded", signature, receiptAddress: receiptPda.toBase58() };
  } catch (error) {
    return { chainStatus: "failed", error: error instanceof Error ? error.message : "Unknown Solana receipt error" };
  }
}
