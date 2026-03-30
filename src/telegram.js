import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";

import { splitTelegramText } from "./lib/utils.js";

const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;

async function postJson(requestUrl, payload) {
  const url = new URL(requestUrl);
  const transport = url.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        family: 4,
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.setTimeout(TELEGRAM_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`telegram request timed out after ${TELEGRAM_REQUEST_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

export function createTelegramClient(apiBaseUrl) {
  async function telegram(method, payload) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const body = await postJson(`${apiBaseUrl}/${method}`, payload);
        if (!body.ok) {
          throw new Error(`${method} failed: ${JSON.stringify(body)}`);
        }
        return body.result;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await delay(500 * attempt);
          continue;
        }
      }
    }

    throw lastError;
  }

  async function ensureCommandMenu(commands) {
    try {
      await telegram("setMyCommands", { commands });
    } catch (error) {
      console.error(`[boot] setMyCommands failed: ${error.message || error}`);
    }
  }

  async function sendText(chatId, text, extra = {}) {
    const chunks = splitTelegramText(text);
    let lastResult = null;
    for (const [index, chunk] of chunks.entries()) {
      lastResult = await telegram("sendMessage", {
        chat_id: Number(chatId),
        text: chunk,
        disable_web_page_preview: true,
        ...(index === chunks.length - 1 ? extra : {}),
      });
    }
    return lastResult;
  }

  async function editText(chatId, messageId, text, extra = {}) {
    return telegram("editMessageText", {
      chat_id: Number(chatId),
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async function answerCallback(callbackQueryId, text = "", showAlert = false) {
    const payload = {
      callback_query_id: callbackQueryId,
    };
    if (text) {
      payload.text = text.slice(0, 180);
    }
    if (showAlert) {
      payload.show_alert = true;
    }
    return telegram("answerCallbackQuery", payload);
  }

  return {
    telegram,
    ensureCommandMenu,
    sendText,
    editText,
    answerCallback,
  };
}
