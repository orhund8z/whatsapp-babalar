const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { fetchHistoryPage } = require("../src/history-loader");

const message = (id, t, body = "A useful message with more than forty characters of text.") => ({ id: { _serialized: id }, t, body });
function fixture(cached, batches = []) {
  let loads = 0;
  const context = vm.createContext({ window: {
    WWebJS: { getChat: async () => ({ msgs: { getModelsArray: () => cached } }), getMessageModel: msg => msg },
    require: () => ({ loadEarlierMsgs: async () => { loads++; return batches.shift() || []; } }),
  } });
  return { client: { pupPage: { evaluate: (fn, job) => vm.runInContext(`(${fn.toString()})`, context)(job) } }, loads: () => loads };
}
const job = { wa_group_id: "group@g.us", before_at: new Date(100000).toISOString(), before_id: null, page_size: 2 };

test("history pages preserve same-second messages with an id cursor", async () => {
  const f = fixture([message("c", 100), message("a", 100), message("b", 100), message("old", 90), message("new", 110)]);
  const first = await fetchHistoryPage(f.client, job);
  assert.equal(first.scanned, 2);
  assert.equal(first.before_id, "b");
  assert.equal(first.exhausted, false);
  const second = await fetchHistoryPage(f.client, { ...job, before_at: first.before_at, before_id: first.before_id });
  assert.equal(second.before_id, "old");
  assert.equal(second.scanned, 2);
  assert.equal(f.loads(), 0);
});

test("filtered messages advance the cursor without falsely ending history", async () => {
  const f = fixture([message("short", 80, "short"), message("normal", 90)]);
  const result = await fetchHistoryPage(f.client, job);
  assert.equal(result.scanned, 2);
  assert.equal(result.messages.length, 1);
  assert.equal(result.before_id, "short");
  assert.equal(result.exhausted, false);
});

test("loads older history, removes overlapping cache entries and detects exhaustion", async () => {
  const f = fixture([message("recent", 150)], [[message("a", 90), message("a", 90)], [message("b", 80)], []]);
  const result = await fetchHistoryPage(f.client, { ...job, page_size: 3 });
  assert.equal(result.scanned, 2);
  assert.equal(result.before_id, "b");
  assert.equal(result.exhausted, true);
  assert.equal(f.loads(), 3);
});

test("a bounded load does not report exhaustion when history is still loading", async () => {
  const f = fixture([], Array.from({ length: 40 }, () => [message("recent", 150)]));
  const result = await fetchHistoryPage(f.client, job);
  assert.equal(result.scanned, 0);
  assert.equal(result.before_at, null);
  assert.equal(result.exhausted, false);
  assert.equal(f.loads(), 40);
});

test("serialization failures reject the page so its cursor cannot be committed", async () => {
  const f = fixture([{ t: 90, body: "broken" }]);
  await assert.rejects(() => fetchHistoryPage(f.client, job), /pagination key/);
});

test("new WhatsApp message keys use their canonical string representation", async () => {
  const item = message("unused", 90);
  item.id = { fromMe: false, id: "message", toString: () => "false_group_message" };
  item.author = { user: "sender" };
  const f = fixture([item]);
  const result = await fetchHistoryPage(f.client, { ...job, page_size: 1 });
  assert.equal(result.before_id, "false_group_message");
  assert.equal(result.messages[0].sender_name, null);
});
