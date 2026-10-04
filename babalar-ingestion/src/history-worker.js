const { fetchHistoryPage } = require("./history-loader");
const { claimHistoryPage, completeHistoryPage, sendMessages, setIngestionStatus, postLog, checkCancel } = require("./api-client");

async function runHistoryPage(client) {
  const job = await claimHistoryPage();
  if (!job) return;
  let timeout;
  let poll;
  let restart = false;
  let saved = 0;
  try {
    await setIngestionStatus(job.wa_group_id);
    await postLog("INFO", `[history] "${job.group_name}": loading up to ${job.page_size} messages before ${job.before_at}.`);
    const interrupt = new Promise((_, reject) => {
      timeout = setTimeout(() => { restart = true; reject(new Error("History page timed out. Retry this page.")); }, 120000);
      poll = setInterval(async () => {
        if (await checkCancel()) {
          restart = true;
          reject(new Error("History page cancelled. Retry this page."));
        }
      }, 3000);
    });
    const page = await Promise.race([fetchHistoryPage(client, job), interrupt]);
    clearTimeout(timeout);
    clearInterval(poll);
    for (let i = 0; i < page.messages.length; i += 100) {
      if (await checkCancel()) throw new Error("History page cancelled. Retry this page.");
      const result = await sendMessages(job.wa_group_id, job.group_name, page.messages.slice(i, i + 100));
      saved += result.saved || 0;
    }
    await completeHistoryPage({ key: job.key, request_id: job.request_id,
      before_at: page.before_at, before_id: page.before_id,
      scanned: page.scanned, saved, exhausted: page.exhausted });
    await postLog("INFO", `[history] "${job.group_name}": ${page.scanned} scanned, ${saved} saved.${page.exhausted ? " No older history available on WhatsApp." : " Next page ready."}`);
  } catch (err) {
    await completeHistoryPage({ key: job.key, request_id: job.request_id, saved, error: err.message || String(err) });
    await postLog("ERROR", `[history] "${job.group_name}": ${err.stack || err}`);
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
    await setIngestionStatus(null).catch(() => {});
    if (restart) process.exit(1);
  }
}

module.exports = { runHistoryPage };
