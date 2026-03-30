import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createTelegramClient } from "../src/telegram.js";

test("createTelegramClient sends JSON POST requests and returns result", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { delivered: true } }));
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const client = createTelegramClient(`http://127.0.0.1:${address.port}`);
    const result = await client.telegram("sendMessage", {
      chat_id: 123,
      text: "hello",
    });
    const sent = await client.sendText(123, "progress");

    assert.deepEqual(result, { delivered: true });
    assert.deepEqual(sent, { delivered: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/sendMessage");
    assert.equal(requests[0].headers["content-type"], "application/json");
    assert.deepEqual(requests[0].body, { chat_id: 123, text: "hello" });
    assert.deepEqual(requests[1].body, {
      chat_id: 123,
      text: "progress",
      disable_web_page_preview: true,
      parse_mode: "MarkdownV2",
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
