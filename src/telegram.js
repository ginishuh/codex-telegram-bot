import { setTimeout as delay } from "node:timers/promises";

import { splitTelegramText } from "./lib/utils.js";

export function createTelegramClient(apiBaseUrl) {
  async function telegram(method, payload) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${apiBaseUrl}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await response.json();
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
    for (const [index, chunk] of chunks.entries()) {
      await telegram("sendMessage", {
        chat_id: Number(chatId),
        text: chunk,
        disable_web_page_preview: true,
        ...(index === chunks.length - 1 ? extra : {}),
      });
    }
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
