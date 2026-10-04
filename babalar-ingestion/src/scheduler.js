const { streamGroupMessages } = require("./whatsapp");
const { discoverGroups, getActiveGroups, sendMessages, markGroupChecked, getIngestConfig, clearForceRun, setIngestionStatus, postLog, checkCancel } = require("./api-client");

const BATCH_SIZE = 100;
const GET_CHATS_TIMEOUT_MS = 900000;
const GET_CHATS_MAX_ATTEMPTS = 6;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getChatsWithRetry(client, logWarn) {
  let lastError;
  for (let attempt = 1; attempt <= GET_CHATS_MAX_ATTEMPTS; attempt++) {
    try {
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("getChats timeout after 15 minutes")), GET_CHATS_TIMEOUT_MS)),
      ]);
      if (Array.isArray(chats) && chats.length > 0) {
        return chats;
      }
      lastError = new Error(`getChats returned ${Array.isArray(chats) ? chats.length : "non-array"} chats`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < GET_CHATS_MAX_ATTEMPTS) {
      const waitMs = attempt * 15000;
      logWarn(`[scheduler] getChats attempt ${attempt}/${GET_CHATS_MAX_ATTEMPTS} failed; retrying in ${waitMs / 1000}s:\n${formatError(lastError)}`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function runIngestion(client, targetGroupId = null) {
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

  const groupsToProcess = targetGroupId
    ? activeGroups.filter((g) => g.wa_group_id === targetGroupId)
    : activeGroups;

  if (!groupsToProcess.length) {
    console.log(`[scheduler] Target group ${targetGroupId} not found in active groups.`);
    return;
  }

  logInfo(`[scheduler] Processing ${groupsToProcess.length} group(s)${targetGroupId ? ` (targeted: ${targetGroupId})` : ""}.`);

  const chatMap = {};
  for (const chat of groupChats) {
    chatMap[chat.id._serialized] = chat;
  }

  for (const group of groupsToProcess) {
    if (await checkCancel()) {
      logWarn("[scheduler] Cancel requested — exiting process for immediate stop.");
      process.exit(0);
    }

    const chat = chatMap[group.wa_group_id];
    if (!chat) {
      logWarn(`[scheduler] "${group.group_name}" not found in WhatsApp, skipping.`);
      continue;
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
