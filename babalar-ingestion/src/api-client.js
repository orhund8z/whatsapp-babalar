const axios = require("axios");

const http = axios.create({
  baseURL: process.env.BACKEND_URL || "http://localhost:8000",
  headers: { "x-ingest-key": process.env.INGEST_API_KEY },
  timeout: 300_000, // 5 min — 100 msgs × categorize + embed takes time
});

async function discoverGroups(waGroupId, groupName) {
  const res = await http.post("/api/ingest/discover", { wa_group_id: waGroupId, group_name: groupName });
  return res.data;
}

async function getActiveGroups() {
  const res = await http.get("/api/ingest/groups");
  return res.data;
}

async function sendMessages(waGroupId, groupName, messages) {
  if (!messages.length) return { saved: 0 };
  const res = await http.post("/api/ingest/messages", {
    wa_group_id: waGroupId,
    group_name: groupName,
    messages,
  });
  return res.data;
}

async function markGroupChecked(waGroupId, groupName, checkedAt) {
  await http.post("/api/ingest/mark-checked", {
    wa_group_id: waGroupId,
    group_name: groupName,
    checked_at: checkedAt ? checkedAt.toISOString() : undefined,
  });
}

async function getIngestConfig() {
  const res = await http.get("/api/ingest/config");
  return res.data;
}

async function checkTrigger() {
  const res = await http.get("/api/ingest/trigger", { timeout: 10000 });
  return res.data;
}

async function clearForceRun() {
  await http.post("/api/ingest/clear-force-run", {}, { timeout: 10000 });
}

async function setIngestionStatus(waGroupId) {
  await http.post("/api/ingest/set-status", { wa_group_id: waGroupId }, { timeout: 10000 });
}

async function setQR(dataUrl) {
  await http.post("/api/ingest/set-qr", { data_url: dataUrl }, { timeout: 10000 });
}

async function clearQR() {
  await http.post("/api/ingest/clear-qr", {}, { timeout: 10000 });
}

async function checkReconnect() {
  const res = await http.get("/api/ingest/reconnect-requested", { timeout: 10000 });
  return res.data;
}

async function setWhatsAppStatus(status) {
  await http.post("/api/ingest/whatsapp-status", { status }, { timeout: 10000 });
}

async function postLog(level, message) {
  try {
    await http.post("/api/ingest/log", { level, message }, { timeout: 5000 });
  } catch (_) {}
}

async function checkCancel() {
  try {
    const res = await http.get("/api/ingest/cancel-requested", { timeout: 5000 });
    return res.data.cancel === true;
  } catch (_) {
    return false;
  }
}

async function claimHistoryPage() {
  return (await http.post("/api/ingest/history/claim", {}, { timeout: 10000 })).data;
}

async function completeHistoryPage(result) {
  return (await http.post("/api/ingest/history/complete", result, { timeout: 10000 })).data;
}

async function recoverHistoryPages() {
  await http.post("/api/ingest/history/recover", {}, { timeout: 10000 });
}

module.exports = { discoverGroups, getActiveGroups, sendMessages, markGroupChecked, getIngestConfig, checkTrigger, clearForceRun, setIngestionStatus, setQR, clearQR, checkReconnect, setWhatsAppStatus, postLog, checkCancel, claimHistoryPage, completeHistoryPage, recoverHistoryPages };
