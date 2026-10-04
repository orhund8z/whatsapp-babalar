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

async function getChatsWithRetry(client, logWarn, opts = {}) {
  const maxAttempts = opts.maxAttempts || GET_CHATS_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs || GET_CHATS_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs || 15000;
  const allowMinimalFallback = opts.allowMinimalFallback !== false;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let timeout;
      let chats;
      try {
        chats = await Promise.race([
          client.getChats(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`getChats timeout after ${timeoutMs}ms`)), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      if (Array.isArray(chats) && chats.length > 0) {
        return chats;
      }
      lastError = new Error(`getChats returned ${Array.isArray(chats) ? chats.length : "non-array"} chats`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxAttempts) {
      const waitMs = attempt * retryDelayMs;
      logWarn(`[scheduler] getChats attempt ${attempt}/${maxAttempts} failed; retrying in ${waitMs / 1000}s:\n${formatError(lastError)}`);
      await sleep(waitMs);
    }
  }

  if (allowMinimalFallback) {
    logWarn(`[scheduler] getChats failed after ${maxAttempts} attempts; trying minimal group discovery fallback:\n${formatError(lastError)}`);
    const minimalChats = await getMinimalChats(client);
    if (minimalChats.length > 0) {
      logWarn(`[scheduler] Minimal group discovery fallback returned ${minimalChats.length} chat(s). Message ingestion requires full chat objects and may be skipped until getChats recovers.`);
      return minimalChats;
    }
  }

  throw lastError;
}

async function getMinimalChats(client) {
  return await client.pupPage.evaluate(() => {
    const chatCollection = window.require("WAWebCollections").Chat;
    const chats = chatCollection.getModelsArray();
    return chats.flatMap((chat) => {
      try {
        const serializedId = chat.id?._serialized || chat.id?.toString?.() || "";
        const isGroup = Boolean(chat.groupMetadata) || serializedId.endsWith("@g.us");
        if (!serializedId || !isGroup) return [];

        const name =
          chat.formattedTitle ||
          chat.name ||
          chat.contact?.formattedName ||
          chat.contact?.pushname ||
          serializedId;

        return [{
          id: { _serialized: serializedId },
          name,
          isGroup: true,
          __minimal: true,
        }];
      } catch (_) {
        return [];
      }
    });
  });
}

module.exports = { getChatsWithRetry, getMinimalChats };
