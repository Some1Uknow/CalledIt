import { Hono, type Context } from "hono";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { z } from "zod";
import { getPool } from "../pools/repository.js";
import { getMarketIntent, getMarketPool } from "./repository.js";
import { isMarketEnabled } from "./onchain.js";
import {
  buildClaimTransaction,
  buildStakeTransaction,
  confirmStakeTransaction,
  formatDevnetSol
} from "./service.js";

const walletSchema = z.object({ walletAddress: z.string().min(32).max(64) });
const confirmSchema = walletSchema.extend({
  entryAddress: z.string().min(32).max(64),
  signature: z.string().min(64).max(100)
});
const require = createRequire(import.meta.url);
const solanaWeb3IifePath = require.resolve("@solana/web3.js/lib/index.iife.min.js");
let solanaWeb3Iife: Promise<string> | null = null;

export function addMarketRoutes(app: Hono) {
  app.get("/assets/solana-web3.iife.min.js", async (c) => {
    if (!isMarketEnabled()) return c.notFound();
    solanaWeb3Iife ??= readFile(solanaWeb3IifePath, "utf8");
    c.header("content-type", "application/javascript; charset=utf-8");
    c.header("cache-control", "public, max-age=3600");
    return c.body(await solanaWeb3Iife);
  });

  app.get("/stake/:token", (c) => {
    if (!isMarketEnabled()) return c.notFound();
    const token = c.req.param("token");
    const intent = getMarketIntent(token);
    if (!intent) return c.html(errorPage("This stake link is invalid."), 404);
    const pool = getPool(intent.poolId);
    const market = getMarketPool(intent.poolId);
    if (!pool || !market) return c.html(errorPage("This pool is no longer available."), 404);
    if (intent.status !== "pending") return c.html(errorPage(intent.status === "expired" ? "This stake link has expired." : "This stake link has already been completed."), 410);
    return page(c, stakePage({
      token,
      fixture: `${pool.fixture.homeTeam} vs ${pool.fixture.awayTeam}`,
      prediction: `${intent.homeGoals}-${intent.awayGoals}`,
      stake: formatDevnetSol(market.stakeLamports)
    }));
  });

  app.get("/claim/:poolId", (c) => {
    if (!isMarketEnabled()) return c.notFound();
    const pool = getPool(c.req.param("poolId"));
    const market = pool ? getMarketPool(pool.id) : null;
    if (!pool || !market) return c.html(errorPage("This claim page is unavailable."), 404);
    return page(c, claimPage({ poolId: pool.id, fixture: `${pool.fixture.homeTeam} vs ${pool.fixture.awayTeam}` }));
  });

  const api = new Hono();
  api.post("/intents/:token/transaction", async (c) => {
    if (!isMarketEnabled()) return c.notFound();
    try {
      const body = walletSchema.parse(await c.req.json());
      const tx = await buildStakeTransaction(c.req.param("token"), body.walletAddress);
      return c.json({
        transactionBase64: tx.transactionBase64,
        entryAddress: tx.entryAddress,
        lastValidBlockHeight: tx.lastValidBlockHeight
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  api.post("/intents/:token/confirm", async (c) => {
    if (!isMarketEnabled()) return c.notFound();
    try {
      const body = confirmSchema.parse(await c.req.json());
      const result = await confirmStakeTransaction({ token: c.req.param("token"), ...body });
      return c.json({ ok: true, predictionId: result.prediction.id });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  api.post("/pools/:poolId/claim-transaction", async (c) => {
    if (!isMarketEnabled()) return c.notFound();
    try {
      const body = walletSchema.parse(await c.req.json());
      const tx = await buildClaimTransaction(c.req.param("poolId"), body.walletAddress);
      return c.json({
        transactionBase64: tx.transactionBase64,
        entryAddress: tx.entryAddress,
        lastValidBlockHeight: tx.lastValidBlockHeight
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  app.route("/api/market", api);
}

function page(c: Context, html: string) {
  const nonce = randomBytes(16).toString("base64");
  c.header("content-security-policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`);
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  return c.html(html.replaceAll("{{NONCE}}", nonce));
}

function stakePage(input: { token: string; fixture: string; prediction: string; stake: string }) {
  return walletPage({
    title: "Fund your CalledIt prediction",
    description: `${input.fixture} · Your exact score: ${input.prediction} · Stake: ${input.stake}`,
    button: "Connect wallet and stake",
    transactionEndpoint: `/api/market/intents/${input.token}/transaction`,
    confirmEndpoint: `/api/market/intents/${input.token}/confirm`,
    completion: "Entry confirmed. You can return to Telegram."
  });
}

function claimPage(input: { poolId: string; fixture: string }) {
  return walletPage({
    title: "Claim your CalledIt result",
    description: `${input.fixture} · Connect the wallet you used to enter. The program will determine whether you can claim a payout or refund.`,
    button: "Connect wallet and claim",
    transactionEndpoint: `/api/market/pools/${input.poolId}/claim-transaction`,
    completion: "Claim submitted. Check your wallet for confirmation."
  });
}

function walletPage(input: {
  title: string;
  description: string;
  button: string;
  transactionEndpoint: string;
  confirmEndpoint?: string;
  completion: string;
}) {
  const state = JSON.stringify(input).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>body{margin:0;background:#0b1020;color:#f7f8fc;font:16px system-ui,-apple-system,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:430px;margin:24px;padding:28px;border:1px solid #2a3457;border-radius:18px;background:#121a31}h1{font-size:24px;margin:0 0 12px}p{line-height:1.55;color:#c4cbe0}button{border:0;border-radius:10px;background:#7cf2bf;color:#071710;font-weight:700;padding:14px 16px;width:100%;font-size:16px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.status{min-height:24px;margin-top:16px;font-size:14px}.fine{font-size:12px;color:#98a3c2;margin-top:22px}</style>
</head><body><main class="card"><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.description)}</p><button id="go">${escapeHtml(input.button)}</button><div class="status" id="status" role="status"></div><p class="fine">Devnet only. CalledIt never receives your wallet private key. Review the transaction in your wallet before signing.</p></main>
<script src="/assets/solana-web3.iife.min.js"></script>
<script nonce="{{NONCE}}">const state=${state};const button=document.getElementById('go');const status=document.getElementById('status');const set=(text,error=false)=>{status.textContent=text;status.style.color=error?'#ff99a4':'#c4cbe0'};const bytes=(b64)=>Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const provider=()=>window.phantom&&window.phantom.solana||window.solana;button.addEventListener('click',async()=>{try{button.disabled=true;const wallet=provider();if(!wallet){throw new Error('Open this link in Phantom or another Solana wallet browser.')}set('Connecting wallet…');const connected=await wallet.connect();const walletAddress=connected.publicKey.toBase58();set('Preparing the exact program transaction…');const txResponse=await fetch(state.transactionEndpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({walletAddress})});const txPayload=await txResponse.json();if(!txResponse.ok)throw new Error(txPayload.error||'Could not prepare transaction');const transaction=solanaWeb3.Transaction.from(bytes(txPayload.transactionBase64));set('Approve the transaction in your wallet…');if(!wallet.signAndSendTransaction)throw new Error('This wallet does not support transaction sending from this page.');const sent=await wallet.signAndSendTransaction(transaction);if(typeof sent.signature!=='string')throw new Error('Wallet returned an unsupported transaction signature.');const signature=sent.signature;if(state.confirmEndpoint){set('Verifying your on-chain entry…');const confirmed=await fetch(state.confirmEndpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({walletAddress,entryAddress:txPayload.entryAddress,signature})});const confirmation=await confirmed.json();if(!confirmed.ok)throw new Error(confirmation.error||'Transaction is still confirming; reopen this link in a moment.');}set(state.completion);}catch(error){set(error instanceof Error?error.message:'Something went wrong.',true);}finally{button.disabled=false;}});</script>
</body></html>`;
}

function errorPage(message: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CalledIt</title><body style="font-family:system-ui;background:#0b1020;color:#f7f8fc;padding:40px">${escapeHtml(message)}</body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
