import { Telegraf, Markup } from 'telegraf';
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

const userStates: Record<string, 'IDLE' | 'AWAITING_UPLOAD_VIDEO' | 'AWAITING_DISKLY_LINK' | 'AWAITING_TERABOX_LINK'> = {};

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
    
    const telegramChatId = ctx.chat.id.toString();
    const state = userStates[telegramChatId] || 'IDLE';

    try {
      let admin = await prisma.admin.findUnique({
        where: { telegramChatId }
      });

      if (!admin) {
        // Not linked yet, try to link with API Key
        admin = await prisma.admin.findUnique({
          where: { telegramUploadId: text }
        });

        if (!admin) {
          return ctx.reply('❌ Invalid Telegram API Key. Please check your admin dashboard and try again.');
        }

        await prisma.admin.update({
          where: { id: admin.id },
          data: { telegramChatId }
        });

        userStates[telegramChatId] = 'IDLE';
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('📤 Upload Video', 'opt_upload')],
          [Markup.button.callback('🔄 Convert Diskly Link', 'opt_diskly')],
          [Markup.button.callback('📥 Convert Terabox Link', 'opt_terabox')],
        ]);
        return ctx.reply(`✅ Successfully linked to account: ${admin.email}\nChoose an option below:`, keyboard);
      }

      // Handle states
      if (state === 'AWAITING_DISKLY_LINK') {
        const match = text.match(/diskly\.in\/([a-zA-Z0-9_-]+)/);
        const targetDownloadKey = match ? match[1] : text;

        const originalVideo = await prisma.video.findFirst({ where: { downloadKey: targetDownloadKey } });
        if (!originalVideo) {
          return ctx.reply("❌ Video not found for that link.");
        }

        const newDownloadKey = nanoid(10);
        await prisma.video.create({
          data: {
            title: originalVideo.title,
            description: originalVideo.description,
            streamUrl: originalVideo.streamUrl,
            downloadKey: newDownloadKey,
            thumbnailUrl: originalVideo.thumbnailUrl,
            adminId: admin.id
          }
        });

        userStates[telegramChatId] = 'IDLE';
        return ctx.reply(`✅ Video copied successfully!\n\n🔗 https://diskly.in/${newDownloadKey}`);
      }

      if (state === 'AWAITING_TERABOX_LINK') {
        const processingMsg = await ctx.reply("🔍 Fetching TeraBox data...");
        
        try {
          const response = await fetch('https://xapiverse.com/api/terabox', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xAPIverse-Key': process.env.TERABOX_API_KEY || ''
            },
            body: JSON.stringify({ url: text })
          });

          const data = await response.json();
          if (data.status !== 'success' || !data.list || data.list.length === 0) {
            return ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, "❌ Failed to fetch video from Terabox link.");
          }

          const fileInfo = data.list[0];
          const downloadUrl = fileInfo.normal_dlink || fileInfo.stream_url || fileInfo.fast_stream_url?.['1080p'] || fileInfo.fast_stream_url?.['720p'] || fileInfo.fast_stream_url?.['480p'];
          
          if (!downloadUrl) {
            return ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, "❌ Could not find a valid download link from Terabox.");
          }

          await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, "⬇️ Downloading video from Terabox...");

          const downloadKey = nanoid(10);
          const ext = fileInfo.name ? fileInfo.name.split('.').pop() : 'mp4';
          const objectKey = `${downloadKey}.${ext}`;
          const localFilePath = path.join(uploadDir, objectKey);
          
          const downloadResponse = await fetch(downloadUrl);
          if (!downloadResponse.ok) throw new Error('Failed to download from Terabox');
          
          const arrayBuffer = await downloadResponse.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          fs.writeFileSync(localFilePath, buffer);

          await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, "☁️ Uploading to Storage...");

          const fileStream = fs.createReadStream(localFilePath);
          const uploadParams = {
            Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
            Key: objectKey,
            Body: fileStream,
            ContentType: 'video/mp4',
          };

          await s3.send(new PutObjectCommand(uploadParams));

          let streamUrl = '';
          const domain = process.env.CLOUDFLARE_DOMAIN || '';
          if (domain.includes('/file/')) {
            streamUrl = `${domain.replace(/\/$/, '')}/${objectKey}`;
          } else {
            streamUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${objectKey}`;
          }

          await prisma.video.create({
            data: {
              title: fileInfo.name || "Terabox Video",
              description: "NA",
              streamUrl,
              downloadKey,
              thumbnailUrl: "",
              adminId: admin.id
            }
          });

          userStates[telegramChatId] = 'IDLE';
          if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);

          return ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, `✅ Video uploaded successfully!\n\n🔗 https://diskly.in/${downloadKey}`);
        } catch (error) {
          console.error('Error handling terabox link:', error);
          return ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, "❌ Error processing Terabox link.");
        }
      }

      // Default
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📤 Upload Video', 'opt_upload')],
        [Markup.button.callback('🔄 Convert Diskly Link', 'opt_diskly')],
        [Markup.button.callback('📥 Convert Terabox Link', 'opt_terabox')],
      ]);
      return ctx.reply("Choose an option:", keyboard);

    } catch (error) {
      console.error('Error handling text input:', error);
      ctx.reply('❌ An error occurred.');
    }
  });

  bot.action('opt_upload', async (ctx) => {
    const telegramChatId = ctx.chat?.id.toString();
    if (!telegramChatId) return;
    userStates[telegramChatId] = 'AWAITING_UPLOAD_VIDEO';
    await ctx.reply("📤 Please send the video you want to upload.");
    await ctx.answerCbQuery();
  });

  bot.action('opt_diskly', async (ctx) => {
    const telegramChatId = ctx.chat?.id.toString();
    if (!telegramChatId) return;
    userStates[telegramChatId] = 'AWAITING_DISKLY_LINK';
    await ctx.reply("🔄 Send the Diskly link (e.g. diskly.in/xyz123) to copy.");
    await ctx.answerCbQuery();
  });

  bot.action('opt_terabox', async (ctx) => {
    const telegramChatId = ctx.chat?.id.toString();
    if (!telegramChatId) return;
    userStates[telegramChatId] = 'AWAITING_TERABOX_LINK';
    await ctx.reply("📥 Send the Terabox link to download and upload.");
    await ctx.answerCbQuery();
  });

  // Handle Video Uploads
  bot.on(message('video'), async (ctx) => {
    try {
      const telegramChatId = ctx.chat.id.toString();
      const state = userStates[telegramChatId] || 'IDLE';
      
      const admin = await prisma.admin.findUnique({
        where: { telegramChatId }
      });

      if (!admin) {
        return ctx.reply('❌ Your account is not linked. Please send /start <Your_Telegram_API_Key> to link your account first.');
      }

      if (state !== 'AWAITING_UPLOAD_VIDEO') {
        return ctx.reply('❌ Please select "Upload Video" from the menu first.');
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

      userStates[telegramChatId] = 'IDLE';

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
