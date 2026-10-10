import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const apiHash = process.env.TELEGRAM_API_HASH || '';
const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

const hasValidCredentials = !isNaN(apiId) && apiId > 0 && apiHash.trim().length > 0 && apiHash !== 'YOUR_TELEGRAM_API_HASH';

export const gramjsClient: any = hasValidCredentials
  ? new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 })
  : null;

export const startGramjsClient = async () => {
  if (!hasValidCredentials || !gramjsClient) {
    console.warn('⚠️ TELEGRAM_API_ID or TELEGRAM_API_HASH is not set. GramJS client will not start.');
    return;
  }

  try {
    await gramjsClient.start({
      botAuthToken: botToken,
    });
    console.log('✅ GramJS Client started successfully.');
  } catch (err) {
    console.error('Failed to start GramJS Client:', err);
  }
};
