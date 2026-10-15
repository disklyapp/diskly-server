import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import superadminRoutes from './routes/superadmin.js';
import adminRoutes from './routes/admin.js';
import videoRoutes from './routes/video.js';

import { setupTelegramBot } from './bot/telegram.js';
import { startGramjsClient } from './bot/gramjs.js';

import {
  corsOptions,
  securityHeaders,
  generalApiLimiter,
  clientVerification,
} from './middleware/security.js';
import { validateProductionSecrets } from './config/env.js';

// Validate production secrets on startup (fails fast if insecure defaults used in production)
validateProductionSecrets();

const app = express();

// Trust reverse proxy (Railway, Cloudflare, Nginx) for accurate client IP in rate limiting
app.set('trust proxy', 1);

// Apply Security HTTP headers (Helmet)
app.use(securityHeaders);

// Apply strict CORS policy
app.use(cors(corsOptions));

// Body parsing with safe size limit
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply general API rate limiter to all /api routes
app.use('/api', generalApiLimiter);

// Routes
app.use('/api/superadmin', superadminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/videos', clientVerification, videoRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Start Telegram Bot
  setupTelegramBot();
  // Start GramJS Client
  startGramjsClient();
});
