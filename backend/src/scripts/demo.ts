import { migrate } from "../db/migrate.js";
import { submitPrediction } from "../predictions/service.js";
import { createPool } from "../pools/repository.js";
import { startReplay } from "../replay/service.js";
import { txlineClient } from "../txline/client.js";
import { upsertFixture } from "../txline/repository.js";
import { upsertDemoUser } from "../telegram/auth.js";

migrate();

const [fixture] = (await txlineClient.fixtures("replayable")).map(upsertFixture);
if (!fixture) throw new Error("No demo fixture available");

const pool = createPool({
  telegramChatId: "demo-chat",
  txlineFixtureDbId: fixture.id,
  createdByUserId: null,
  mode: "replay",
  lockAt: fixture.kickoffAt
});

for (const prediction of [
  { name: "Raghav", home: 3, away: 3 },
  { name: "Priya", home: 1, away: 0 },
  { name: "Aman", home: 2, away: 1 }
]) {
  const user = upsertDemoUser(prediction.name);
  submitPrediction({
    poolId: pool.id,
    userId: user.id,
    predictedHomeGoals: prediction.home,
    predictedAwayGoals: prediction.away
  });
}

const result = await startReplay(pool.id);

console.log(
  JSON.stringify(
    {
      poolId: pool.id,
      fixture: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
      receiptHash: result.receiptHash,
      winners: result.receipt.winners,
      miniAppUrl: `/pool/${pool.id}`
    },
    null,
    2
  )
);
