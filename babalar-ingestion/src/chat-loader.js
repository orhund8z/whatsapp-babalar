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
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("getChats timeout after 15 minutes")), timeoutMs)),
      ]);
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

  throw lastError;
}

module.exports = { getChatsWithRetry };
