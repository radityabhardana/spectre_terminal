const [{ databasePath: storagePath }, analytics] = await Promise.all([
  import("../../src/storage.js"),
  import("../../src/analytics.js"),
]);

console.log(`DATABASE_PATH_PROBE ${JSON.stringify({ storagePath, analyticsHasDatabasePath: "databasePath" in analytics })}`);
