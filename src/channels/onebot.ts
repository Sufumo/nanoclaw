import WebSocket from 'ws';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  NewMessage,
  RegisteredGroup,
} from '../types.js';
import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';

// Read OneBot config from .env file
const envConfig = readEnvFile(['ONEBOT_WS_URL', 'ONEBOT_ACCESS_TOKEN', 'ONEBOT_SELF_ID']);
const ONEBOT_WS_URL = process.env.ONEBOT_WS_URL || envConfig.ONEBOT_WS_URL || 'ws://127.0.0.1:6700';
const ONEBOT_ACCESS_TOKEN = process.env.ONEBOT_ACCESS_TOKEN || envConfig.ONEBOT_ACCESS_TOKEN || '';
const ONEBOT_SELF_ID = process.env.ONEBOT_SELF_ID || envConfig.ONEBOT_SELF_ID || ''; // Bot's QQ number

interface OneBotMessage {
  post_type?: string;
  message_type?: string;
  time?: number;
  self_id?: number;
  user_id?: number;
  group_id?: number;
  message?: OneBotMessageSegment[] | string;
  raw_message?: string;
  message_id?: number;
  sender?: {
    user_id?: number;
    nickname?: string;
    card?: string;
  };
  // For API responses
  status?: string;
  retcode?: number;
  data?: Record<string, unknown>;
  echo?: string;
  // For meta events
  meta_event_type?: string;
  status_detail?: {
    online?: boolean;
    good?: boolean;
  };
}

interface OneBotMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

interface PendingApiCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class OneBotChannel implements Channel {
  name = 'onebot';
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCalls = new Map<string, PendingApiCall>();
  private callId = 0;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (ONEBOT_ACCESS_TOKEN) {
        headers['Authorization'] = `Bearer ${ONEBOT_ACCESS_TOKEN}`;
      }

      logger.info({ url: ONEBOT_WS_URL }, 'OneBot: Connecting to WebSocket');
      this.ws = new WebSocket(ONEBOT_WS_URL, { headers });

      this.ws.on('open', () => {
        logger.info('OneBot: WebSocket connected');
        this.connected = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        logger.error({ err }, 'OneBot: WebSocket error');
      });

      this.ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, 'OneBot: WebSocket closed');
        this.connected = false;
        this.scheduleReconnect();
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('OneBot connection timeout'));
        }
      }, 10000);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      logger.info('OneBot: Attempting reconnect...');
      this.connect().catch((err) => {
        logger.error({ err }, 'OneBot: Reconnect failed');
      });
    }, 5000);
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: OneBotMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logger.warn({ data: data.toString() }, 'OneBot: Failed to parse message');
      return;
    }

    // Handle API response
    if (msg.echo !== undefined) {
      const pending = this.pendingCalls.get(msg.echo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCalls.delete(msg.echo);
        if (msg.status === 'ok') {
          pending.resolve(msg.data);
        } else {
          pending.reject(new Error(`OneBot API error: ${msg.retcode}`));
        }
      }
      return;
    }

    // Handle heartbeat - don't send to NapCat as API call
    if (msg.meta_event_type === 'heartbeat') {
      logger.debug('OneBot: Heartbeat received');
      return;
    }

    // Handle meta events
    if (msg.post_type === 'meta_event') {
      logger.debug({ event: msg.meta_event_type }, 'OneBot: Meta event');
      return;
    }

    // Handle messages
    if (msg.post_type === 'message') {
      this.processInboundMessage(msg);
    }
  }

  private processInboundMessage(msg: OneBotMessage): void {
    const isGroup = msg.message_type === 'group';
    const chatJid = isGroup
      ? `onebot:group:${msg.group_id}`
      : `onebot:private:${msg.user_id}`;

    const senderId = msg.sender?.user_id || msg.user_id || 0;
    const senderName = isGroup
      ? (msg.sender?.card || msg.sender?.nickname || String(senderId))
      : (msg.sender?.nickname || String(senderId));

    // Extract text content from message.
    // OneBot sends @mentions as separate "at" segments; we only kept "text" before,
    // so "@Elfi 你好" became "你好" and the trigger was lost. Preserve trigger by
    // turning at-segments targeting this bot into "@ASSISTANT_NAME " in content.
    let content = '';
    if (typeof msg.message === 'string') {
      content = msg.message;
    } else if (Array.isArray(msg.message)) {
      const parts: string[] = [];
      for (const seg of msg.message) {
        if (seg.type === 'text') {
          parts.push(String(seg.data?.text ?? ''));
        } else if (seg.type === 'at') {
          const qq = seg.data?.qq != null ? String(seg.data.qq) : '';
          if (ONEBOT_SELF_ID && qq === ONEBOT_SELF_ID) {
            parts.push(`@${ASSISTANT_NAME} `);
          } else if (qq === 'all') {
            parts.push('@all ');
          }
        }
      }
      content = parts.join('');
    } else if (msg.raw_message) {
      content = msg.raw_message;
    }

    const timestamp = msg.time ? new Date(msg.time * 1000).toISOString() : new Date().toISOString();

    // First, ensure the chat exists in the database
    this.onChatMetadata(chatJid, timestamp, isGroup ? `Group ${msg.group_id}` : senderName, 'onebot', isGroup);

    // Then store the message
    const newMsg: NewMessage = {
      id: String(msg.message_id || Date.now()),
      chat_jid: chatJid,
      sender: String(senderId),
      sender_name: senderName,
      content: content.trim(),
      timestamp,
      is_from_me: String(senderId) === ONEBOT_SELF_ID,
      is_bot_message: false,
    };

    this.onMessage(chatJid, newMsg);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error('OneBot: Not connected');
    }

    const parts = jid.split(':');
    if (parts.length < 3) {
      throw new Error(`OneBot: Invalid JID format: ${jid}`);
    }

    const type = parts[1]; // 'group' or 'private'
    const targetId = parseInt(parts[2], 10);

    const message: OneBotMessageSegment[] = [
      { type: 'text', data: { text } },
    ];

    const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = type === 'group'
      ? { group_id: targetId, message }
      : { user_id: targetId, message };

    await this.callApi(action, params);
  }

  private callApi(action: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const echo = String(++this.callId);

      const payload = JSON.stringify({
        action,
        params,
        echo,
      });

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('OneBot: WebSocket not open'));
        return;
      }

      this.ws.send(payload, (err) => {
        if (err) {
          reject(err);
          return;
        }
      });

      // Set timeout for response
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`OneBot API timeout for action: ${action}`));
      }, 10000);

      this.pendingCalls.set(echo, { resolve, reject, timer });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('onebot:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    // Clear pending calls
    for (const [echo, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('OneBot: Disconnected'));
    }
    this.pendingCalls.clear();
  }
}

// Self-registration
registerChannel('onebot', (opts: ChannelOpts): Channel | null => {
  if (!ONEBOT_WS_URL) {
    logger.debug('OneBot: ONEBOT_WS_URL not set, skipping channel');
    return null;
  }
  return new OneBotChannel(opts);
});

export { OneBotChannel };
