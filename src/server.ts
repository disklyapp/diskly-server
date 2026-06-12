import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import superadminRoutes from './routes/superadmin.js';
import adminRoutes from './routes/admin.js';
import videoRoutes from './routes/video.js';

import { setupTelegramBot } from './bot/telegram.js';
import { startGramjsClient } from './bot/gramjs.js';

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/superadmin', superadminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/videos', videoRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Start Telegram Bot
  setupTelegramBot();
  // Start GramJS Client
  startGramjsClient();
});
