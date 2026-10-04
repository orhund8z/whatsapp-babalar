const fs = require("fs");
const cron = require("node-cron");
const { initWhatsApp } = require("./whatsapp");
const { runIngestion } = require("./scheduler");
const { runHistoryPage } = require("./history-worker");
const { checkTrigger, checkReconnect, postLog, setIngestionStatus, recoverHistoryPages } = require("./api-client");

const CRON = process.env.INGEST_CRON || "0 2 * * *";
const POLL_INTERVAL_MS = 30_000;

function formatError(err) {
  if (!err) return "Unknown error";
  if (err.stack) return err.stack;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

async function main() {
  console.log(`[babalar-ingestion] Starting... (version: ${process.env.APP_VERSION || "dev"})`);
  const client = await initWhatsApp();

  let isRunning = false;

  async function safeRun(reason, targetGroupIds = null, history = false) {
    if (isRunning) return;
    isRunning = true;
    const label = Array.isArray(targetGroupIds)
      ? `groups:${targetGroupIds.length}`
      : targetGroupIds ? `group:${targetGroupIds}` : "all";
    const startMsg = `[babalar-ingestion] Ingestion started (${reason}, ${label})`;
    console.log(startMsg);
    postLog("INFO", startMsg).catch(() => {});
    try {
      if (history) await runHistoryPage(client);
      else await runIngestion(client, targetGroupIds);
    } catch (err) {
      const errMsg = `[babalar-ingestion] Ingestion error:\n${formatError(err)}`;
      console.error(errMsg);
      postLog("ERROR", errMsg).catch(() => {});
    } finally {
      isRunning = false;
    }
  }

  // Clear any stuck "İşleniyor" status left over from a previous crashed run
  await setIngestionStatus(null).catch(() => {});
  await recoverHistoryPages();

  console.log(`[babalar-ingestion] Cron scheduled: ${CRON}`);
  postLog("INFO", `[babalar-ingestion] WhatsApp connected. Cron: ${CRON}`).catch(() => {});
  cron.schedule(CRON, () => safeRun("cron", null));

  // Poll for manual triggers, new unprocessed groups, and reconnect requests
  setInterval(async () => {
    try {
      const { reconnect } = await checkReconnect();
      if (reconnect) {
        const msg = "[babalar-ingestion] Reconnect requested — restarting...";
        console.log(msg);
        postLog("WARN", msg).catch(() => {});
        try { fs.rmSync("./session", { recursive: true, force: true }); } catch (_) {}
        process.exit(0);
      }
    } catch (_) {}

    if (isRunning) return;
    try {
      const { should_run, group_id, group_ids, history } = await checkTrigger();
      if (should_run) safeRun(history ? "history" : "trigger", group_ids || group_id || null, history === true);
    } catch (_) {}
  }, POLL_INTERVAL_MS);

  console.log("[babalar-ingestion] Ready.");

  if (process.env.RUN_NOW === "true") {
    await safeRun("startup");
  }
}

main().catch(async (err) => {
  const errMsg = `[babalar-ingestion] Fatal:\n${formatError(err)}`;
  console.error(errMsg);
  await postLog("ERROR", errMsg).catch(() => {});
  process.exit(1);
});
