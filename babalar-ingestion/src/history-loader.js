async function fetchHistoryPage(client, job) {
  return client.pupPage.evaluate(async ({ wa_group_id, before_at, before_id, page_size }) => {
    const chat = await window.WWebJS.getChat(wa_group_id, { getAsModel: false });
    if (!chat) throw new Error("WhatsApp group is unavailable");
    const beforeTs = Math.floor(new Date(before_at).getTime() / 1000);
    if (!Number.isFinite(beforeTs)) throw new Error("Invalid history cursor");
    const key = msg => {
      const id = msg.id?._serialized || (typeof msg.id === "string" ? msg.id : msg.id?.toString?.());
      if (typeof id !== "string" || !id || id === "[object Object]" || !Number.isFinite(msg.t)) {
        throw new Error("WhatsApp message has no valid pagination key");
      }
      return id;
    };
    const messages = new Map();
    const add = batch => { for (const msg of batch) messages.set(key(msg), msg); };
    add(chat.msgs.getModelsArray());
    const eligible = () => [...messages.values()].filter(msg =>
      msg.t < beforeTs || (msg.t === beforeTs && (!before_id || key(msg) < before_id))
    );
    let exhausted = false;
    let loads = 0;
    const start = Date.now();
    // Bound each request; the browser retains loaded history for the next page.
    while (eligible().length < page_size && loads < 40 && Date.now() - start < 90000) {
      const older = await window.require("WAWebChatLoadMessages").loadEarlierMsgs({ chat });
      loads++;
      if (!older?.length) { exhausted = true; break; }
      add(older);
    }
    const candidates = eligible().sort((a, b) => b.t - a.t || (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
    const page = candidates.slice(0, page_size);
    const oldest = page[page.length - 1];
    return {
      scanned: page.length,
      exhausted: exhausted && candidates.length <= page_size,
      before_at: oldest ? new Date(oldest.t * 1000).toISOString() : null,
      before_id: oldest ? key(oldest) : null,
      messages: page.flatMap(msg => {
        if (msg.isNotification) return [];
        const model = window.WWebJS.getMessageModel(msg);
        if (!model.body || model.body.trim().length < 40) return [];
        return [{ sender_name: model.notifyName || model.author?._serialized || (typeof model.author === "string" ? model.author : null),
          content: model.body, sent_at: new Date(msg.t * 1000).toISOString() }];
      }),
    };
  }, job);
}

module.exports = { fetchHistoryPage };
