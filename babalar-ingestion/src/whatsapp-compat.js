async function installChatCompatibility(client) {
  return client.pupPage.evaluate(() => {
    const api = window.WWebJS;
    if (!api?.getChatModel) return false;
    if (api.getChatModel.__validLastMessageKey) return true;
    const original = api.getChatModel;
    const compatible = async function(chat, options) {
      // New WhatsApp models can expose a last-message key without _serialized.
      // Only omit that preview; leave the model and its message history intact.
      if (chat?.lastReceivedKey && !chat.lastReceivedKey._serialized) {
        chat = new Proxy(chat, {
          get(target, key) {
            if (key === "lastReceivedKey") return null;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      return original.call(api, chat, options);
    };
    compatible.__validLastMessageKey = true;
    api.getChatModel = compatible;
    return true;
  });
}

module.exports = { installChatCompatibility };
