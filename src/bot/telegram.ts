import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import prisma from '../config/prisma.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';

// B2 Client Setup
const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY || '',
  },
});

const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

export const setupTelegramBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN is not set in .env. Telegram Bot will not start.');
    return null;
  }

  const bot = new Telegraf(token);

  bot.start((ctx) => {
    return ctx.reply('Welcome to Diskly. We are a premier video streaming platform.\nYou can use this bot to upload videos directly to your account.\n\nPlease just paste your Telegram API Key below to link your account.');
  });

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return; // Ignore commands

    const telegramUploadId = text;

    try {
      const admin = await prisma.admin.findUnique({
        where: { telegramUploadId }
      });

      if (!admin) {
        return ctx.reply('❌ Invalid Telegram API Key. Please check your admin dashboard and try again.');
      }

      // Link account
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramChatId: ctx.chat.id.toString() }
      });

      ctx.reply(`✅ Successfully linked to account: ${admin.email}\nYou can now send videos directly to this bot to upload them to Diskly!`);
    } catch (error) {
      console.error('Error linking telegram account:', error);
      ctx.reply('❌ An error occurred while linking your account.');
    }
  });

  // Handle Video Uploads
  bot.on(message('video'), async (ctx) => {
    try {
      const telegramChatId = ctx.chat.id.toString();
      
      const admin = await prisma.admin.findUnique({
        where: { telegramChatId }
      });

      if (!admin) {
        return ctx.reply('❌ Your account is not linked. Please send /start <Your_Telegram_API_Key> to link your account first.');
      }

      if (!admin.isActive) {
        return ctx.reply('❌ Your account is currently deactivated.');
      }

      // Check upload limits
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const videosToday = await prisma.video.count({
        where: { adminId: admin.id, createdAt: { gte: today } }
      });

      if (videosToday >= admin.dailyUploadLimit) {
        return ctx.reply('❌ You have reached your daily upload limit.');
      }

      // Telegram Bot API limit is 20MB. Telegraf file size is in bytes.
      const video = ctx.message.video;
      if (video.file_size && video.file_size > 20 * 1024 * 1024) {
        return ctx.reply('❌ Video is larger than 20MB. The Telegram Bot API restricts bots from downloading files larger than 20MB.');
      }

      const processingMessage = await ctx.reply('⏳ Processing video upload...');

      // 1. Get File Link from Telegram
      const fileUrl = await ctx.telegram.getFileLink(video.file_id);
      
      // 2. Download File locally temporarily
      const downloadKey = nanoid(10);
      const ext = video.mime_type?.split('/')[1] || 'mp4';
      const objectKey = `${downloadKey}.${ext}`;
      const localFilePath = path.join(uploadDir, objectKey);
      
      const response = await fetch(fileUrl.toString());
      if (!response.ok) throw new Error('Failed to download video from Telegram');
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(localFilePath, buffer);

      // 3. Optional: Get Thumbnail from Telegram if available
      let thumbObjectKey = '';
      let localThumbPath = '';
      if (video.thumbnail) {
        const thumbUrl = await ctx.telegram.getFileLink(video.thumbnail.file_id);
        const thumbResponse = await fetch(thumbUrl.toString());
        if (thumbResponse.ok) {
          const thumbBuffer = Buffer.from(await thumbResponse.arrayBuffer());
          thumbObjectKey = `${downloadKey}_thumb.jpg`;
          localThumbPath = path.join(uploadDir, thumbObjectKey);
          fs.writeFileSync(localThumbPath, thumbBuffer);
        }
      }

      // 4. Upload to B2
      const fileStream = fs.createReadStream(localFilePath);
      const uploadParams = {
        Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
        Key: objectKey,
        Body: fileStream,
        ContentType: video.mime_type || 'video/mp4',
      };
      
      const uploadPromises = [s3.send(new PutObjectCommand(uploadParams))];
      
      let thumbUploadParams = null;
      if (localThumbPath) {
        const thumbStream = fs.createReadStream(localThumbPath);
        thumbUploadParams = {
          Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
          Key: thumbObjectKey,
          Body: thumbStream,
          ContentType: 'image/jpeg',
        };
        uploadPromises.push(s3.send(new PutObjectCommand(thumbUploadParams)));
      }

      await Promise.all(uploadPromises);

      // 5. Calculate URLs
      let streamUrl = '';
      let finalThumbnailUrl = '';
      const domain = process.env.CLOUDFLARE_DOMAIN || '';
      
      if (domain.includes('/file/')) {
        streamUrl = `${domain.replace(/\/$/, '')}/${objectKey}`;
        if (localThumbPath) finalThumbnailUrl = `${domain.replace(/\/$/, '')}/${thumbObjectKey}`;
      } else {
        streamUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${objectKey}`;
        if (localThumbPath) finalThumbnailUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${thumbObjectKey}`;
      }

      // Use default file name as title and "NA" as description
      const title = video.file_name || 'Telegram Upload';
      const description = 'NA';

      // 6. Create Database Record
      const videoRecord = await prisma.video.create({
        data: { 
          title, 
          description,
          streamUrl, 
          downloadKey, 
          thumbnailUrl: finalThumbnailUrl, 
          adminId: admin.id 
        }
      });

      // Cleanup local files
      fs.unlinkSync(localFilePath);
      if (localThumbPath) fs.unlinkSync(localThumbPath);

      // 7. Reply Success
      const finalLink = `https://diskly.in/${downloadKey}`;
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        undefined,
        `✅ Video uploaded successfully!\n\nLink: ${finalLink}\nTitle: ${title}`
      );

    } catch (error) {
      console.error('Error handling telegram video upload:', error);
      ctx.reply('❌ An error occurred while uploading your video. Please try again later.');
    }
  });

  bot.launch()
    .then(() => console.log('Telegram Bot started successfully.'))
    .catch((err) => console.error('Failed to start Telegram Bot:', err));

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
};
