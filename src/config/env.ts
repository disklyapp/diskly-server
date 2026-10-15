import dotenv from "dotenv";
dotenv.config();

export const env = {
  JWT_SECRET: process.env.JWT_SECRET || 'supersecret',
  B2_BUCKET: process.env.B2_BUCKET_NAME || 'diskly',
  CDN: process.env.CLOUDFLARE_DOMAIN || 'cdn.diskly.in',
};

export function validateProductionSecrets() {
  const isProduction = process.env.NODE_ENV === 'production';
  const weakSecrets = ['supersecret', 'secret', 'password', '123456', 'admin'];

  if (isProduction) {
    if (!process.env.JWT_SECRET || weakSecrets.includes(process.env.JWT_SECRET.toLowerCase())) {
      console.error('FATAL SECURITY ERROR: JWT_SECRET must be set to a strong custom secret in production!');
      process.exit(1);
    }

    if (!process.env.SUPERADMIN_PASSWORD || weakSecrets.includes(process.env.SUPERADMIN_PASSWORD.toLowerCase())) {
      console.error('FATAL SECURITY ERROR: SUPERADMIN_PASSWORD must not be a default/weak password in production!');
      process.exit(1);
    }

    if (!process.env.B2_ACCESS_KEY_ID || !process.env.B2_SECRET_ACCESS_KEY) {
      console.error('FATAL SECURITY ERROR: Backblaze B2 credentials (B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY) are required in production!');
      process.exit(1);
    }
    console.log('Production security validation passed.');
  } else {
    console.log('Development environment: running with developer fallback security defaults.');
  }
}