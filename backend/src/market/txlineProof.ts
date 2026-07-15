import type { TxlineProofNode, TxlineProofPayload, TxlineScoreStat, TxlineStatLeaf } from "./onchain.js";

type JsonRecord = Record<string, unknown>;

export function parseTxlineScoreProof(raw: unknown): TxlineProofPayload {
  const root = record(raw, "TxLINE validation response");
  const summary = record(field(root, ["summary"]), "TxLINE proof summary");
  const updateStats = record(field(summary, ["updateStats", "update_stats"]), "TxLINE update stats");
  const statsRaw = array(field(root, ["statsToProve", "stats_to_prove"]), "TxLINE statsToProve");
  const proofsRaw = array(field(root, ["statProofs", "stat_proofs"]), "TxLINE statProofs");
  if (statsRaw.length !== 2 || proofsRaw.length !== 2) throw new Error("TxLINE final score proof must contain exactly two stats");

  const stats = statsRaw.map((value, index) => ({
    stat: parseScoreStat(value),
    statProof: parseProofNodes(proofsRaw[index])
  })) as TxlineStatLeaf[];
  if (stats[0]?.stat.key !== 1 || stats[1]?.stat.key !== 2 || stats.some((item) => item.stat.period !== 0)) {
    throw new Error("TxLINE final score proof must provide total-goal stats 1 and 2 in order");
  }

  const minTimestamp = int64(field(updateStats, ["minTimestamp", "min_timestamp"]), "TxLINE minTimestamp");
  const payload: TxlineProofPayload = {
    ts: minTimestamp,
    fixtureSummary: {
      fixtureId: int64(field(summary, ["fixtureId", "fixture_id"]), "TxLINE fixtureId"),
      updateStats: {
        updateCount: int32(field(updateStats, ["updateCount", "update_count"]), "TxLINE updateCount"),
        minTimestamp,
        maxTimestamp: int64(field(updateStats, ["maxTimestamp", "max_timestamp"]), "TxLINE maxTimestamp")
      },
      eventsSubTreeRoot: bytes32(field(summary, ["eventStatsSubTreeRoot", "eventsSubTreeRoot", "event_stats_sub_tree_root"]))
    },
    fixtureProof: parseProofNodes(field(root, ["subTreeProof", "sub_tree_proof"])),
    mainTreeProof: parseProofNodes(field(root, ["mainTreeProof", "main_tree_proof"])),
    eventStatRoot: bytes32(field(root, ["eventStatRoot", "event_stat_root"])),
    stats
  };
  return payload;
}

function parseScoreStat(value: unknown): TxlineScoreStat {
  const stat = record(value, "TxLINE score stat");
  return {
    key: uint32(field(stat, ["key"]), "TxLINE stat key"),
    value: int32(field(stat, ["value"]), "TxLINE stat value"),
    period: int32(field(stat, ["period"]), "TxLINE stat period")
  };
}

function parseProofNodes(value: unknown): TxlineProofNode[] {
  return array(value, "TxLINE proof nodes").map((item) => {
    const node = record(item, "TxLINE proof node");
    const sibling = field(node, ["isRightSibling", "is_right_sibling"]);
    if (typeof sibling !== "boolean") throw new Error("TxLINE proof node has an invalid sibling flag");
    return { hash: bytes32(field(node, ["hash"])), isRightSibling: sibling };
  });
}

function field(source: JsonRecord, names: string[]) {
  for (const name of names) {
    if (name in source) return source[name];
  }
  throw new Error(`TxLINE response is missing ${names[0]}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} is invalid`);
  return value;
}

function bytes32(value: unknown) {
  const out =
    value instanceof Uint8Array
      ? Buffer.from(value)
      : Array.isArray(value)
        ? bytesFromArray(value)
        : typeof value === "string"
          ? value.startsWith("0x")
            ? bytesFromHex(value)
            : Buffer.from(value, "base64")
          : isBufferJson(value)
            ? bytesFromArray(value.data)
            : null;
  if (!out || out.length !== 32) throw new Error("TxLINE hash must be 32 bytes");
  return out;
}

function bytesFromArray(value: unknown[]) {
  if (value.some((item) => !Number.isInteger(item) || (item as number) < 0 || (item as number) > 255)) {
    throw new Error("TxLINE hash contains an invalid byte");
  }
  return Buffer.from(value as number[]);
}

function bytesFromHex(value: string) {
  const hex = value.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("TxLINE hash must be a 32-byte hex value");
  return Buffer.from(hex, "hex");
}

function isBufferJson(value: unknown): value is { type: "Buffer"; data: number[] } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

function numberValue(value: unknown, label: string) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  throw new Error(`${label} is invalid`);
}

function int32(value: unknown, label: string) {
  const parsed = numberValue(value, label);
  if (!Number.isInteger(parsed) || parsed < -2_147_483_648 || parsed > 2_147_483_647) throw new Error(`${label} is outside i32 range`);
  return parsed;
}

function uint32(value: unknown, label: string) {
  const parsed = numberValue(value, label);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4_294_967_295) throw new Error(`${label} is outside u32 range`);
  return parsed;
}

function int64(value: unknown, label: string) {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`${label} is invalid`);
}
