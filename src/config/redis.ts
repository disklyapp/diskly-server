import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Connection for Workers (maxRetriesPerRequest must be null for BullMQ workers)
export const workerConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Connection for Queue / Producer
export const queueConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
});

// Gracefully close connections on termination signals to prevent connection leaks
const graceShutDown = async (signal: string) => {
  console.log(`Received ${signal}. Closing Redis connections...`);
  try {
    await Promise.all([
      workerConnection.quit(),
      queueConnection.quit(),
    ]);
    console.log('Redis connections closed successfully.');
  } catch (err) {
    console.error('Error while closing Redis connections:', err);
  }
};

process.once('SIGINT', () => graceShutDown('SIGINT'));
process.once('SIGTERM', () => graceShutDown('SIGTERM'));
process.once('SIGUSR2', () => graceShutDown('SIGUSR2')); // For tsx/nodemon restarts

