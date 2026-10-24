import { config } from './config';

// Thin Telegram Bot API client on global fetch (node >= 18).

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramError extends Error {
  constructor(message: string, public errorCode?: number) {
    super(message);
    this.name = 'TelegramError';
  }
}

async function call<T>(method: string, payload?: object, timeoutMs = 40000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.telegramBase}/bot${config.telegramToken}/${method}`, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok || json.result === undefined) {
      throw new TelegramError(json.description || `Telegram API ${method} failed`, json.error_code);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function getMe(): Promise<TgUser> {
  return call<TgUser>('getMe');
}

export async function setMyCommands(): Promise<void> {
  await call<boolean>('setMyCommands', {
    commands: [
      { command: 'start', description: 'Get your user id and a one-time pairing code' },
      { command: 'status', description: 'Server status and uptime' },
    ],
  });
}

export async function sendMessage(chatId: number, text: string): Promise<{ message_id: number }> {
  return call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

export async function sendDocument(
  chatId: number,
  bytes: Buffer,
  filename: string
): Promise<{ message_id: number }> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const safeName = filename.replace(/[\r\n"]/g, '_');
  form.append('document', new Blob([new Uint8Array(bytes)]), safeName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(`${config.telegramBase}/bot${config.telegramToken}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    const json = (await res.json()) as TgResponse<{ message_id: number }>;
    if (!json.ok || json.result === undefined) {
      throw new TelegramError(json.description || 'sendDocument failed', json.error_code);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

export async function getUpdates(offset?: number, timeoutSec = 0): Promise<TgUpdate[]> {
  const payload: Record<string, unknown> = { timeout: timeoutSec, limit: 100 };
  if (offset !== undefined) payload.offset = offset;
  return call<TgUpdate[]>('getUpdates', payload, (timeoutSec + 15) * 1000);
}

export async function deleteWebhook(): Promise<void> {
  await call<boolean>('deleteWebhook', { drop_pending_updates: false });
}

/**
 * Single-instance getUpdates polling loop. Two pollers on one bot = HTTP 409
 * from Telegram, so the server must be the only consumer of the bot.
 */
export function startPolling(handlers: {
  onStart: (userId: number) => void;
  onAnyMessage: (userId: number) => void;
  onStatus: (userId: number) => void;
}): { stop: () => void } {
  let stopped = false;
  let offset: number | undefined = undefined;
  let inFlight: Promise<void> | null = null;

  async function loop() {
    while (!stopped) {
      try {
        const updates = await getUpdates(offset, 25);
        for (const update of updates) {
          offset = update.update_id + 1; // ack every batch
          const message = update.message;
          if (!message || !message.from || !message.text) continue;
          if (message.chat.type !== 'private') continue;
          const userId = message.from.id;
          const command = message.text.split(/\s+/)[0];
          if (command === '/start') handlers.onStart(userId);
          else if (command === '/status') handlers.onStatus(userId);
          else handlers.onAnyMessage(userId);
        }
      } catch (err) {
        if (stopped) return;
        const code = (err as TelegramError).errorCode;
        if (code === 409) {
          // Another poller/webhook is active; warn loudly and retry.
          console.error(
            '[polling] HTTP 409: another getUpdates consumer or a webhook is active on this bot. ' +
              'Make sure exactly one visend-server instance uses this bot token.'
          );
          await delay(10000);
        } else {
          console.error('[polling] getUpdates failed:', (err as Error).message);
          await delay(3000);
        }
      }
    }
  }

  inFlight = loop();
  return {
    stop: () => {
      stopped = true;
      // In-flight long poll resolves within ~25s; the process can wait or exit.
      inFlight?.catch(() => undefined);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
