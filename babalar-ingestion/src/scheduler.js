const { streamGroupMessages } = require("./whatsapp");
const { discoverGroups, getActiveGroups, sendMessages, markGroupChecked, getIngestConfig, clearForceRun, setIngestionStatus, postLog, checkCancel } = require("./api-client");
const { getChatsWithRetry } = require("./chat-loader");

const BATCH_SIZE = 100;

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

async function getFullChatById(client, waGroupId, logWarn) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await client.getChatById(waGroupId);
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        logWarn(`[scheduler] getChatById attempt ${attempt}/3 failed for ${waGroupId}; retrying:\n${formatError(err)}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
      }
    }
  }
  throw lastError;
}

async function runIngestion(client, targetGroupIds = null) {
  // Record start time before cache load so mark-checked uses this timestamp,
  // not the end time. Messages arriving during a long run won't be permanently skipped.
  const runStartTime = new Date();

  // Clear any pending force_run flag at the start so it isn't re-consumed
  // by the next trigger poll while this run is in progress.
  await clearForceRun().catch(() => {});

  const logInfo = (msg) => { console.log(msg); postLog("INFO", msg).catch(() => {}); };
  const logWarn = (msg) => { console.warn(msg); postLog("WARN", msg).catch(() => {}); };
  const logError = (msg) => { console.error(msg); postLog("ERROR", msg).catch(() => {}); };

  logInfo("[scheduler] Loading chats...");
  const chats = await getChatsWithRetry(client, logWarn);
  const groupChats = chats.filter((c) => c.isGroup);
  logInfo(`[scheduler] Found ${groupChats.length} groups.`);

  // Discover all groups (save as inactive if new)
  for (const chat of groupChats) {
    try {
      await discoverGroups(chat.id._serialized, chat.name);
    } catch (err) {
      logWarn(`[scheduler] Discovery failed for "${chat.name}": ${formatError(err)}`);
    }
  }
  logInfo("[scheduler] Group discovery done. Only active groups will be ingested.");

  // Fetch config and active groups
  let lookbackDays = 30;
  try {
    const cfg = await getIngestConfig();
    lookbackDays = cfg.ingestion_lookback_days || 30;
    console.log(`[scheduler] Lookback: ${lookbackDays} days.`);
  } catch (err) {
    logWarn(`[scheduler] Could not fetch ingest config, defaulting to 30 days: ${formatError(err)}`);
  }

  let activeGroups = [];
  try {
    activeGroups = await getActiveGroups();
  } catch (err) {
    logError(`[scheduler] Failed to fetch active groups: ${formatError(err)}`);
    return;
  }

  if (!activeGroups.length) {
    logInfo("[scheduler] No active groups. Activate groups from the admin panel.");
    return;
  }

  const targetSet = Array.isArray(targetGroupIds)
    ? new Set(targetGroupIds)
    : targetGroupIds ? new Set([targetGroupIds]) : null;

  const groupsToProcess = targetSet
    ? activeGroups.filter((g) => targetSet.has(g.wa_group_id))
    : activeGroups;

  if (!groupsToProcess.length) {
    console.log(`[scheduler] Target group(s) ${targetSet ? [...targetSet].join(", ") : ""} not found in active groups.`);
    return;
  }

  logInfo(`[scheduler] Processing ${groupsToProcess.length} group(s)${targetSet ? " (targeted)" : ""}.`);

  const chatMap = {};
  for (const chat of groupChats) {
    chatMap[chat.id._serialized] = chat;
  }

  for (const group of groupsToProcess) {
    if (await checkCancel()) {
      logWarn("[scheduler] Cancel requested — exiting process for immediate stop.");
      process.exit(0);
    }

    let chat = chatMap[group.wa_group_id];
    if (!chat) {
      logWarn(`[scheduler] "${group.group_name}" not found in WhatsApp, skipping.`);
      continue;
    }
    if (chat.__minimal) {
      try {
        logWarn(`[scheduler] "${group.group_name}" discovered through minimal fallback; loading full chat by id before message ingestion.`);
        chat = await getFullChatById(client, group.wa_group_id, logWarn);
      } catch (err) {
        logWarn(`[scheduler] "${group.group_name}" full chat load failed; message ingestion skipped:\n${formatError(err)}`);
        continue;
      }
    }

    const since = group.last_ingested_at
      ? new Date(group.last_ingested_at)
      : new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    logInfo(`[scheduler] Processing "${group.group_name}" (since: ${since.toISOString().slice(0,10)})...`);

    try {
      await setIngestionStatus(group.wa_group_id).catch(() => {});
      let totalFetched = 0;
      let totalSaved = 0;
      let pageCount = 0;

      for await (const page of streamGroupMessages(chat, since, checkCancel)) {
        pageCount++;
        totalFetched += page.length;

        for (let i = 0; i < page.length; i += BATCH_SIZE) {
          const batch = page.slice(i, i + BATCH_SIZE);
          const result = await sendMessages(group.wa_group_id, group.group_name, batch);
          totalSaved += result.saved || 0;
        }

        if (pageCount % 10 === 0) {
          const oldest = page.length ? page[page.length - 1].sent_at : "?";
          logInfo(`[scheduler] "${group.group_name}": ${totalFetched} fetched, ${totalSaved} saved, oldest: ${oldest}`);
        }
      }

      if (totalFetched === 0) {
        logInfo(`[scheduler] "${group.group_name}": no new messages.`);
      } else {
        logInfo(`[scheduler] "${group.group_name}": done. ${totalFetched} fetched, ${totalSaved} saved.`);
      }
      await markGroupChecked(group.wa_group_id, group.group_name, runStartTime);
    } catch (err) {
      if (err.message === "CANCELLED") {
        logWarn(`[scheduler] "${group.group_name}": cancelled — exiting process.`);
        process.exit(0);
      }
      logError(`[scheduler] Error processing "${group.group_name}":\n${formatError(err)}`);
    } finally {
      await setIngestionStatus(null).catch(() => {});
    }
  }

  logInfo("[scheduler] Ingestion complete.");
}

module.exports = { runIngestion };
