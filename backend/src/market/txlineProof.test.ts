import { describe, expect, it } from "vitest";
import { parseTxlineScoreProof } from "./txlineProof.js";

const hash = Buffer.alloc(32, 7).toString("base64");

function validProof() {
  return {
    summary: {
      fixtureId: "17952170",
      updateStats: { updateCount: 12, minTimestamp: "1720000000000", maxTimestamp: "1720000010000" },
      eventStatsSubTreeRoot: hash
    },
    subTreeProof: [{ hash, isRightSibling: true }],
    mainTreeProof: [{ hash, isRightSibling: false }],
    eventStatRoot: hash,
    statsToProve: [
      { key: 1, value: 2, period: 0 },
      { key: 2, value: 1, period: 0 }
    ],
    statProofs: [[{ hash, isRightSibling: true }], [{ hash, isRightSibling: false }]]
  };
}

describe("parseTxlineScoreProof", () => {
  it("parses the exact two full-game score leaves", () => {
    const proof = parseTxlineScoreProof(validProof());
    expect(proof.fixtureSummary.fixtureId).toBe(17_952_170n);
    expect(proof.ts).toBe(1_720_000_000_000n);
    expect(proof.stats.map((leaf) => leaf.stat)).toEqual([
      { key: 1, value: 2, period: 0 },
      { key: 2, value: 1, period: 0 }
    ]);
  });

  it("rejects non-final-score stat keys and malformed bytes", () => {
    const wrongKey = validProof();
    wrongKey.statsToProve[1] = { key: 3, value: 1, period: 0 };
    expect(() => parseTxlineScoreProof(wrongKey)).toThrow("total-goal stats 1 and 2");

    const invalidByte: Record<string, unknown> = validProof();
    invalidByte.eventStatRoot = Array.from({ length: 32 }, () => 999);
    expect(() => parseTxlineScoreProof(invalidByte)).toThrow("invalid byte");
  });
});
