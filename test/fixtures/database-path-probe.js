const [{ databasePath: storagePath }, { databasePath: analyticsPath }] = await Promise.all([
  import("../../src/storage.js"),
  import("../../src/analytics.js"),
]);

console.log(`DATABASE_PATH_PROBE ${JSON.stringify({ storagePath, analyticsPath })}`);
