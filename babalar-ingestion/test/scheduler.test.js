const assert = require("node:assert/strict");
const test = require("node:test");

const { getChatsWithRetry } = require("../src/chat-loader");

test("getChatsWithRetry retries transient WhatsApp getChats failures", async () => {
  let calls = 0;
  const warnings = [];
  const expectedChats = [{ id: "chat-1", isGroup: true }];
  const client = {
    async getChats() {
      calls += 1;
      if (calls < 3) {
        const error = new Error("r");
        error.name = "r";
        throw error;
      }
      return expectedChats;
    },
  };

  const chats = await getChatsWithRetry(client, (msg) => warnings.push(msg), {
    maxAttempts: 4,
    retryDelayMs: 1,
    timeoutMs: 1000,
  });

  assert.equal(calls, 3);
  assert.deepEqual(chats, expectedChats);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /getChats attempt 1\/4 failed/);
});

test("getChatsWithRetry throws the last error after attempts are exhausted", async () => {
  let calls = 0;
  const client = {
    async getChats() {
      calls += 1;
      throw new Error("still syncing");
    },
  };

  await assert.rejects(
    () => getChatsWithRetry(client, () => {}, {
      maxAttempts: 2,
      retryDelayMs: 1,
      timeoutMs: 1000,
    }),
    /still syncing/
  );
  assert.equal(calls, 2);
});
