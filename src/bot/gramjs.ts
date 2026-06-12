import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const apiHash = process.env.TELEGRAM_API_HASH || '';
const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

export const gramjsClient = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
});

export const startGramjsClient = async () => {
  if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
    console.warn('⚠️ TELEGRAM_API_ID or TELEGRAM_API_HASH is not set. GramJS client will not start.');
    return;
  }

  await gramjsClient.start({
    botAuthToken: botToken,
  });

  console.log('✅ GramJS Client started successfully.');
};
