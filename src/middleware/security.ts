import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import helmet from 'helmet';

// 1. Strict CORS Whitelist Configuration
const defaultOrigins = [
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:3000',
  'https://attractive-achievement-production-cffb.up.railway.app',
  'https://diskly.in',
  'https://www.diskly.in',
  'https://admin.diskly.in',
  'https://cdn.diskly.in',
];

const customOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : [];

export const allowedOrigins = Array.from(new Set([...defaultOrigins, ...customOrigins]));

export const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow mobile apps, curl, server-to-server requests without Origin header
    if (!origin) return callback(null, true);

    const isAllowed = allowedOrigins.some((allowed) => {
      if (allowed === origin) return true;
      // Allow subdomains of diskly.in or railway.app
      if (origin.endsWith('.railway.app') || origin.endsWith('.diskly.in')) return true;
      return false;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error(`Blocked by CORS policy: Origin ${origin} is not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Diskly-Client',
  ],
  maxAge: 86400, // 24 hours
};

// 2. Helmet HTTP Security Headers
export const securityHeaders = helmet({
  contentSecurityPolicy: false, // Allows flexible video and image streaming across CDNs
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows media assets to be embedded
  frameguard: { action: 'sameorigin' },
  dnsPrefetchControl: { allow: false },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  xssFilter: true,
});

// 3. Multi-Tiered Rate Limiters
// General API rate limiter (protects against scrapers / DDoS)
export const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests from this IP, please try again after 15 minutes.',
  },
});

// Strict Login / Auth limiter (protects against brute-force attacks)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Max 15 login attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts. Please wait 15 minutes before trying again.',
  },
});

// Upload rate limiter (protects B2 storage bandwidth & abuse)
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Max 50 upload operations per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Upload rate limit exceeded. Please wait before uploading more files.',
  },
});

// 4. Client Handshake Verification Middleware
// Verifies that requests to the public/mobile API originate from the genuine Diskly app or admin portal
export const clientVerification = (req: Request, res: Response, next: NextFunction) => {
  // Allow browser preflight OPTIONS requests
  if (req.method === 'OPTIONS' || req.path === '/health') {
    return next();
  }

  // Allow authenticated admin/superadmin requests (checked by their own JWT auth middleware)
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return next();
  }

  const expectedKey = process.env.DISKLY_CLIENT_KEY || 'diskly-secure-client-2026';
  const clientKey = req.headers['x-diskly-client-key'];

  // Check origin/referer to allow web frontend and admin portal
  const origin = (req.headers.origin as string) || (req.headers.referer as string) || '';
  const isTrustedWebOrigin =
    origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    origin.includes('diskly.in') ||
    origin.includes('railway.app');

  // Also check User-Agent for Diskly mobile app, ExoPlayer, or native Android network client
  const userAgent = (req.headers['user-agent'] as string) || '';
  const isAppClient =
    userAgent.includes('DisklyApp') ||
    userAgent.includes('Dart') ||
    userAgent.includes('ExoPlayer') ||
    userAgent.includes('okhttp') ||
    userAgent.includes('stagefright');

  if (clientKey === expectedKey || isTrustedWebOrigin || isAppClient) {
    return next();
  }

  return res.status(403).json({
    error: 'Access denied: Unauthorized client. Valid X-Diskly-Client-Key handshake required.',
  });
};

