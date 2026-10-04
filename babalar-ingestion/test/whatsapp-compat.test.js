const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { installChatCompatibility } = require("../src/whatsapp-compat");

test("invalid preview keys do not reach IndexedDB and history remains intact", async () => {
  const history = [{ body: "preserved" }];
  const chat = {
    lastReceivedKey: { id: "new-key-format" },
    msgs: history,
    serialize() { assert.equal(this, chat); return { id: "group" }; },
  };
  const api = {
    async getChatModel(model, options) {
      assert.equal(this, api);
      if (model.lastReceivedKey && !model.lastReceivedKey._serialized) {
        throw new Error("No key or key range specified");
      }
      return { ...model.serialize(), msgs: model.msgs, options };
    },
  };
  const context = vm.createContext({ window: { WWebJS: api } });
  const client = { pupPage: { evaluate: fn => vm.runInContext(`(${fn.toString()})()`, context) } };
  assert.equal(await installChatCompatibility(client), true);
  const wrapper = api.getChatModel;
  assert.equal(await installChatCompatibility(client), true);
  assert.equal(api.getChatModel, wrapper);
  const options = { isChannel: false };
  const result = await api.getChatModel(chat, options);
  assert.equal(result.msgs, history);
  assert.equal(result.options, options);
  assert.equal(chat.lastReceivedKey.id, "new-key-format");
});

test("valid keys pass through unchanged and installation waits for injection", async () => {
  const window = {};
  const context = vm.createContext({ window });
  const client = { pupPage: { evaluate: fn => vm.runInContext(`(${fn.toString()})()`, context) } };
  assert.equal(await installChatCompatibility(client), false);
  const chat = { lastReceivedKey: { _serialized: "valid" } };
  window.WWebJS = { getChatModel: async model => model };
  await installChatCompatibility(client);
  assert.equal(await window.WWebJS.getChatModel(chat), chat);
});
