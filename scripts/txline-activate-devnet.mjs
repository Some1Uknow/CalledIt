import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";

const DEVNET = {
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  apiOrigin: "https://txline-dev.txodds.com",
  programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
  txlTokenMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG")
};

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPF5s9W3eqrFHG3ew7hC");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const SERVICE_LEVEL_ID = 1;
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = [];
const envPath = path.resolve("backend/.env.local");
const keypairPath = expandHome(process.env.SOLANA_KEYPAIR ?? "~/.config/solana/id.json");

function expandHome(value) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function readKeypair(filePath) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8"))));
}

function setEnvValue(filePath, key, value) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const line = `${key}=${value}`;
  const next = current.match(new RegExp(`^${key}=.*$`, "m"))
    ? current.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${current.trimEnd()}\n${line}\n`;
  fs.writeFileSync(filePath, next.endsWith("\n") ? next : `${next}\n`);
}

function getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve = false) {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new Error("Owner cannot be off curve");
  }
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

function createAssociatedTokenAccountInstruction(payer, associatedToken, owner, mint) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: Buffer.alloc(0)
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function fetchDevnetIdl() {
  const markdown = await fetch("https://txline.txodds.com/documentation/programs/devnet.md").then((res) => res.text());
  const match = markdown.match(/```json[^\n]*\n([\s\S]*?)```/);
  if (!match) throw new Error("Could not find TxLINE devnet IDL JSON in docs");
  return JSON.parse(match[1]);
}

async function main() {
  const payer = readKeypair(keypairPath);
  const wallet = new anchor.Wallet(payer);
  const connection = new Connection(DEVNET.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = await fetchDevnetIdl();
  const program = new anchor.Program(idl, provider);
  if (!program.programId.equals(DEVNET.programId)) {
    throw new Error(`Loaded program ${program.programId.toBase58()} does not match TxLINE devnet program`);
  }

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], program.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    DEVNET.txlTokenMint,
    tokenTreasuryPda,
    true
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], program.programId);
  const userTokenAccount = getAssociatedTokenAddressSync(
    DEVNET.txlTokenMint,
    payer.publicKey,
    false
  );

  console.log(`Using wallet ${payer.publicKey.toBase58()}`);

  const userTokenAccountInfo = await connection.getAccountInfo(userTokenAccount);
  if (!userTokenAccountInfo) {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userTokenAccount,
        payer.publicKey,
        DEVNET.txlTokenMint
      )
    );
    const ataSig = await sendAndConfirmTransaction(connection, createAtaTx, [payer], { commitment: "confirmed" });
    console.log(`Created TxL associated token account: ${ataSig}`);
  }

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: payer.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: DEVNET.txlTokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID
    })
    .rpc();

  console.log(`Subscription transaction: ${txSig}`);

  const auth = await fetchJson(`${DEVNET.apiOrigin}/auth/guest/start`, { method: "POST" });
  const jwt = auth.token;
  if (!jwt) throw new Error("TxLINE guest auth did not return token");

  const message = new TextEncoder().encode(`${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(message, payer.secretKey)).toString("base64");
  const activation = await fetchJson(`${DEVNET.apiOrigin}/api/token/activate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({ txSig, walletSignature, leagues: SELECTED_LEAGUES })
  });
  const apiToken = activation.token ?? activation;
  if (typeof apiToken !== "string" || apiToken.length === 0) {
    throw new Error("TxLINE activation did not return an API token");
  }

  setEnvValue(envPath, "TXLINE_BASE_URL", "https://txline-dev.txodds.com/api/");
  setEnvValue(envPath, "TXLINE_AUTH_JWT", jwt);
  setEnvValue(envPath, "TXLINE_API_TOKEN", apiToken);
  console.log("Wrote TXLINE_AUTH_JWT and TXLINE_API_TOKEN to backend/.env.local");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
