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

// Helper: Find linked admin by Telegram Chat ID
const getLinkedAdmin = async (telegramChatId: string) => {
  return await prisma.admin.findUnique({
    where: { telegramChatId }
  });
};

// Helper: Check if a URL is a Terabox link
const isTeraboxLink = (url: string): boolean => {
  const lowercaseUrl = url.toLowerCase();
  const domains = [
    'terabox', 'nephobox', 'playit', 'teraboxapp', 'tibibox', 
    'freeterabox', '1024tera', '4fpdownload', 'mirrorbox', 
    'momotbox', 'teraboxshare'
  ];
  return domains.some(domain => lowercaseUrl.includes(domain));
};

// Helper: Check if a URL is a Diskly link
const isDisklyLink = (url: string): boolean => {
  const lowercaseUrl = url.toLowerCase();
  return lowercaseUrl.includes('diskly.in/') || lowercaseUrl.includes('diskly.co/') || lowercaseUrl.includes('diskly.link/');
};

// Helper: Process a single Terabox link
const processTeraboxLink = async (url: string, adminId: number): Promise<string> => {
  const response = await fetch('https://xapiverse.com/api/terabox', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xAPIverse-Key': process.env.TERABOX_API_KEY || ''
    },
    body: JSON.stringify({ url })
  });

  const data = await response.json();
  if (data.status !== 'success' || !data.list || data.list.length === 0) {
    throw new Error(`Failed to fetch video from Terabox link: ${url}`);
  }

  const fileInfo = data.list[0];
  const downloadUrl = fileInfo.normal_dlink || fileInfo.stream_url || fileInfo.fast_stream_url?.['1080p'] || fileInfo.fast_stream_url?.['720p'] || fileInfo.fast_stream_url?.['480p'];
  
  if (!downloadUrl) {
    throw new Error(`Could not find a valid download link from Terabox for link: ${url}`);
  }

  const downloadKey = nanoid(10);
  const ext = fileInfo.name ? fileInfo.name.split('.').pop() : 'mp4';
  const objectKey = `${downloadKey}.${ext}`;
  const localFilePath = path.join(uploadDir, objectKey);
  
  const downloadResponse = await fetch(downloadUrl);
  if (!downloadResponse.ok) throw new Error(`Failed to download from Terabox: ${url}`);
  
  const arrayBuffer = await downloadResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(localFilePath, buffer);

  let thumbObjectKey = '';
  let localThumbPath = '';
  if (fileInfo.thumbnail) {
    try {
      const thumbResponse = await fetch(fileInfo.thumbnail);
      if (thumbResponse.ok) {
        const thumbBuffer = Buffer.from(await thumbResponse.arrayBuffer());
        thumbObjectKey = `${downloadKey}_thumb.jpg`;
        localThumbPath = path.join(uploadDir, thumbObjectKey);
        fs.writeFileSync(localThumbPath, thumbBuffer);
      }
    } catch (err) {
      console.error("Failed to download terabox thumbnail", err);
    }
  }

  const fileStream = fs.createReadStream(localFilePath);
  const uploadParams = {
    Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
    Key: objectKey,
    Body: fileStream,
    ContentType: 'video/mp4',
  };

  const uploadPromises = [s3.send(new PutObjectCommand(uploadParams))];

  if (localThumbPath) {
    const thumbStream = fs.createReadStream(localThumbPath);
    const thumbUploadParams = {
      Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
      Key: thumbObjectKey,
      Body: thumbStream,
      ContentType: 'image/jpeg',
    };
    uploadPromises.push(s3.send(new PutObjectCommand(thumbUploadParams)));
  }

  await Promise.all(uploadPromises);

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

  await prisma.video.create({
    data: {
      title: fileInfo.name || "Terabox Video",
      description: "NA",
      streamUrl,
      downloadKey,
      thumbnailUrl: finalThumbnailUrl,
      size: buffer.length,
      adminId
    }
  });

  if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
  if (localThumbPath && fs.existsSync(localThumbPath)) fs.unlinkSync(localThumbPath);

  return `https://diskly.in/${downloadKey}`;
};

// Helper: Process a single Diskly link (clone)
const processDisklyLink = async (url: string, adminId: number): Promise<string> => {
  const match = url.match(/diskly\.in\/([a-zA-Z0-9_-]+)/i) || url.match(/diskly\.co\/([a-zA-Z0-9_-]+)/i) || url.match(/diskly\.link\/([a-zA-Z0-9_-]+)/i);
  const targetDownloadKey = match ? match[1] : url;

  const originalVideo = await prisma.video.findFirst({ where: { downloadKey: targetDownloadKey } });
  if (!originalVideo) {
    throw new Error(`Video not found for Diskly link: ${url}`);
  }

  const newDownloadKey = nanoid(10);
  await prisma.video.create({
    data: {
      title: originalVideo.title,
      description: originalVideo.description,
      streamUrl: originalVideo.streamUrl,
      downloadKey: newDownloadKey,
      thumbnailUrl: originalVideo.thumbnailUrl,
      size: originalVideo.size,
      adminId
    }
  });

  return `https://diskly.in/${newDownloadKey}`;
};

// Helper: Process direct Telegram video upload
const processVideoMessage = async (ctx: any, video: any, adminId: number): Promise<{ downloadKey: string; title: string }> => {
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin) throw new Error("Admin not found.");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const videosToday = await prisma.video.count({
    where: { adminId: admin.id, createdAt: { gte: today } }
  });

  if (videosToday >= admin.dailyUploadLimit) {
    throw new Error("You have reached your daily upload limit.");
  }

  if (video.file_size && video.file_size > 20 * 1024 * 1024) {
    throw new Error("Video is larger than 20MB. Telegram Bot API limits direct video downloads to 20MB.");
  }

  const fileUrl = await ctx.telegram.getFileLink(video.file_id);
  const downloadKey = nanoid(10);
  const ext = video.mime_type?.split('/')[1] || 'mp4';
  const objectKey = `${downloadKey}.${ext}`;
  const localFilePath = path.join(uploadDir, objectKey);
  
  const response = await fetch(fileUrl.toString());
  if (!response.ok) throw new Error('Failed to download video from Telegram');
  
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(localFilePath, buffer);

  let thumbObjectKey = '';
  let localThumbPath = '';
  if (video.thumbnail) {
    try {
      const thumbUrl = await ctx.telegram.getFileLink(video.thumbnail.file_id);
      const thumbResponse = await fetch(thumbUrl.toString());
      if (thumbResponse.ok) {
        const thumbBuffer = Buffer.from(await thumbResponse.arrayBuffer());
        thumbObjectKey = `${downloadKey}_thumb.jpg`;
        localThumbPath = path.join(uploadDir, thumbObjectKey);
        fs.writeFileSync(localThumbPath, thumbBuffer);
      }
    } catch (err) {
      console.error("Failed to download video thumbnail", err);
    }
  }

  const fileStream = fs.createReadStream(localFilePath);
  const uploadParams = {
    Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
    Key: objectKey,
    Body: fileStream,
    ContentType: video.mime_type || 'video/mp4',
  };
  
  const uploadPromises = [s3.send(new PutObjectCommand(uploadParams))];
  
  if (localThumbPath) {
    const thumbStream = fs.createReadStream(localThumbPath);
    const thumbUploadParams = {
      Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
      Key: thumbObjectKey,
      Body: thumbStream,
      ContentType: 'image/jpeg',
    };
    uploadPromises.push(s3.send(new PutObjectCommand(thumbUploadParams)));
  }

  await Promise.all(uploadPromises);

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

  const title = video.file_name || 'Telegram Upload';
  const description = 'NA';

  await prisma.video.create({
    data: { 
      title, 
      description,
      streamUrl, 
      downloadKey, 
      thumbnailUrl: finalThumbnailUrl, 
      size: video.file_size || buffer.length,
      adminId: admin.id 
    }
  });

  if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
  if (localThumbPath && fs.existsSync(localThumbPath)) fs.unlinkSync(localThumbPath);

  return { downloadKey, title };
};

export const setupTelegramBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN is not set in .env. Telegram Bot will not start.');
    return null;
  }

  const bot = new Telegraf(token);

  // 1. /start Command
  bot.start(async (ctx) => {
    try {
      const telegramChatId = ctx.chat.id.toString();
      const admin = await getLinkedAdmin(telegramChatId);
      if (admin) {
        return ctx.reply(
          `👋 <b>Welcome back to Diskly Telegram Bot!</b>\n\n` +
          `🔗 <b>Linked Account:</b> <code>${admin.email}</code>\n` +
          `🚦 <b>Status:</b> ${admin.isActive ? 'Active ✅' : 'Deactivated ❌'}\n\n` +
          `<b>Available Commands:</b>\n` +
          `/start - View bot status and commands\n` +
          `/link_account - Link/switch Diskly Upload ID\n` +
          `/add_header - Add custom text above links/messages\n` +
          `/remove_header - Remove custom header\n` +
          `/add_footer - Add custom text below links/messages\n` +
          `/remove_footer - Remove custom footer\n` +
          `/enable_text - Keep surrounding text\n` +
          `/disable_text - Remove surrounding text\n` +
          `/my_account - View account details & stats`,
          { parse_mode: 'HTML' }
        );
      } else {
        return ctx.reply(
          `👋 <b>Welcome to Diskly Telegram Bot!</b>\n\n` +
          `To get started, please link your Diskly account to this bot using your Upload ID.\n\n` +
          `<b>Steps to Link:</b>\n` +
          `1. Go to your Diskly Dashboard.\n` +
          `2. Copy your <b>Telegram Upload ID</b>.\n` +
          `3. Use the command: <code>/link_account &lt;your_upload_id&gt;</code>\n\n` +
          `<b>Available Commands:</b>\n` +
          `/start - View bot status and commands\n` +
          `/link_account - Link your Diskly Upload ID\n` +
          `/add_header - Add custom text above links/messages\n` +
          `/remove_header - Remove custom header\n` +
          `/add_footer - Add custom text below links/messages\n` +
          `/remove_footer - Remove custom footer\n` +
          `/enable_text - Keep surrounding text\n` +
          `/disable_text - Remove surrounding text\n` +
          `/my_account - View account details & stats`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error('Error in /start command:', err);
    }
  });

  // 2. /link_account Command
  bot.command('link_account', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/link_account\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: Link Account</b>\n\n` +
        `Link your Diskly account to this bot to bind it permanently.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/link_account &lt;upload_id&gt;</code>\n\n` +
        `<b>Example:</b>\n` +
        `<code>/link_account 6f9a8b7c</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await prisma.admin.findUnique({
        where: { telegramUploadId: arg }
      });
      
      if (!admin) {
        return ctx.reply(`❌ <b>Invalid Upload ID.</b> Please check your admin dashboard and try again.`, { parse_mode: 'HTML' });
      }
      
      const telegramChatId = ctx.chat.id.toString();
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramChatId }
      });
      
      return ctx.reply(`✅ <b>Successfully linked to account:</b> <code>${admin.email}</code>`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Error linking account:', error);
      return ctx.reply(`❌ <b>An error occurred during account linking.</b>`, { parse_mode: 'HTML' });
    }
  });

  // 3. /add_header Command
  bot.command('add_header', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/add_header\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: Add Header</b>\n\n` +
        `Add custom text above your processed links/messages.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/add_header &lt;text&gt;</code>\n\n` +
        `<b>Example:</b>\n` +
        `<code>/add_header 🍿 Join @MyChannel for daily movies!</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account &lt;upload_id&gt;</code>.`, { parse_mode: 'HTML' });
      }
      
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramHeader: arg }
      });
      
      return ctx.reply(`✅ <b>Custom header added successfully:</b>\n\n${arg}`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(error);
    }
  });

  // 4. /remove_header Command
  bot.command('remove_header', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/remove_header\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: Remove Header</b>\n\n` +
        `Remove the custom header text you've added.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/remove_header yes</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account &lt;upload_id&gt;</code>.`, { parse_mode: 'HTML' });
      }
      
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramHeader: null }
      });
      
      return ctx.reply(`✅ <b>Custom header removed successfully.</b>`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(error);
    }
  });

  // 5. /add_footer Command
  bot.command('add_footer', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/add_footer\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: Add Footer</b>\n\n` +
        `Add custom text below your processed links/messages.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/add_footer &lt;text&gt;</code>\n\n` +
        `<b>Example:</b>\n` +
        `<code>/add_footer 🚀 Powered by @Diskly</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account &lt;upload_id&gt;</code>.`, { parse_mode: 'HTML' });
      }
      
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramFooter: arg }
      });
      
      return ctx.reply(`✅ <b>Custom footer added successfully:</b>\n\n${arg}`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(error);
    }
  });

  // 6. /remove_footer Command
  bot.command('remove_footer', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/remove_footer\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: Remove Footer</b>\n\n` +
        `Remove the custom footer text you've added.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/remove_footer yes</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account &lt;upload_id&gt;</code>.`, { parse_mode: 'HTML' });
      }
      
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramFooter: null }
      });
      
      return ctx.reply(`✅ <b>Custom footer removed successfully.</b>`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(error);
    }
  });

  // 7. /enable_text Command
  bot.command('enable_text', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/enable_text\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: Enable Text</b>\n\n` +
        `Keep the surrounding text when processing messages.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/enable_text yes</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account &lt;upload_id&gt;</code>.`, { parse_mode: 'HTML' });
      }
      
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramKeepText: true }
      });
      
      return ctx.reply(`✅ <b>Text preservation enabled.</b> Surrounding text will be kept when processing messages.`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(error);
    }
  });

  // 8. /disable_text Command
  bot.command('disable_text', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/disable_text\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: Disable Text</b>\n\n` +
        `Remove surrounding text from messages and keep only the links/content.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/disable_text yes</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account &lt;upload_id&gt;</code>.`, { parse_mode: 'HTML' });
      }
      
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramKeepText: false }
      });
      
      return ctx.reply(`✅ <b>Text preservation disabled.</b> Surrounding text will be removed and only the links will be kept.`, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(error);
    }
  });

  // 9. /my_account Command
  bot.command('my_account', async (ctx) => {
    const text = ctx.message.text.trim();
    const arg = text.replace(/^\/my_account\s*/, '').trim();
    if (!arg) {
      return ctx.reply(
        `📖 <b>Tutorial: My Account</b>\n\n` +
        `View your account details and dashboard statistics.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/my_account yes</code>`,
        { parse_mode: 'HTML' }
      );
    }
    
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account &lt;upload_id&gt;</code>.`, { parse_mode: 'HTML' });
      }
      
      const totalVideos = await prisma.video.count({
        where: { adminId: admin.id }
      });
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayVideos = await prisma.video.count({
        where: { adminId: admin.id, createdAt: { gte: today } }
      });
      
      return ctx.reply(
        `👤 <b>Diskly Account Details</b>\n` +
        `📧 <b>Email:</b> <code>${admin.email}</code>\n` +
        `🏷️ <b>Name:</b> ${admin.name || 'N/A'}\n` +
        `🔑 <b>Upload ID:</b> <code>${admin.telegramUploadId}</code>\n` +
        `🚦 <b>Status:</b> ${admin.isActive ? 'Active ✅' : 'Deactivated ❌'}\n\n` +
        `📊 <b>Dashboard Statistics</b>\n` +
        `💰 <b>Balance:</b> $${admin.balance.toFixed(2)}\n` +
        `💵 <b>Total Earnings:</b> $${admin.totalEarnings.toFixed(2)}\n` +
        `📹 <b>Total Videos:</b> ${totalVideos}\n` +
        `📈 <b>Today's Uploads:</b> ${todayVideos} / ${admin.dailyUploadLimit}\n\n` +
        `⚙️ <b>Bot Settings</b>\n` +
        `📝 <b>Keep Caption Text:</b> ${admin.telegramKeepText ? 'Enabled ✅' : 'Disabled ❌'}\n` +
        `🔝 <b>Header:</b> ${admin.telegramHeader ? `<code>${admin.telegramHeader}</code>` : '<i>None</i>'}\n` +
        `🔛 <b>Footer:</b> ${admin.telegramFooter ? `<code>${admin.telegramFooter}</code>` : '<i>None</i>'}`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Error fetching statistics:', error);
      return ctx.reply(`❌ <b>An error occurred while fetching your account details.</b>`, { parse_mode: 'HTML' });
    }
  });

  // 10. General incoming message processing handler (automating video uploads and conversions)
  bot.on(['message', 'edited_message'], async (ctx) => {
    try {
      const messageObj = ctx.message || ctx.editedMessage;
      if (!messageObj) return;

      const telegramChatId = ctx.chat.id.toString();
      const admin = await getLinkedAdmin(telegramChatId);

      if (!admin) {
        return ctx.reply(`❌ Your account is not linked. Please use <code>/link_account &lt;upload_id&gt;</code> to link your account first.`, { parse_mode: 'HTML' });
      }

      if (!admin.isActive) {
        return ctx.reply('❌ Your account is currently deactivated.');
      }

      // Extract raw text or caption from incoming message
      const rawText = ('text' in messageObj ? messageObj.text : 'caption' in messageObj ? messageObj.caption : '') || '';
      
      // Ignore if it's a command
      if (rawText.trim().startsWith('/')) {
        return;
      }

      const urlRegex = /https?:\/\/[^\s]+/gi;
      const urls = rawText.match(urlRegex) || [];

      // Categorize extracted links
      const teraboxUrls = urls.filter(isTeraboxLink);
      const disklyUrls = urls.filter(isDisklyLink);

      const uniqueTeraboxUrls = Array.from(new Set(teraboxUrls));
      const uniqueDisklyUrls = Array.from(new Set(disklyUrls));

      const isVideoAttached = 'video' in messageObj;

      let taskDetected = false;
      let replacedText = rawText;
      const newLinks: string[] = [];

      let processingMsg = null;

      // Dynamic task detection routing
      if (uniqueTeraboxUrls.length > 0) {
        // Terabox link conversion
        taskDetected = true;
        processingMsg = await ctx.reply(`🔍 Processing ${uniqueTeraboxUrls.length} Terabox link(s)...`);

        for (const url of uniqueTeraboxUrls) {
          try {
            const disklyLink = await processTeraboxLink(url, admin.id);
            replacedText = replacedText.split(url).join(disklyLink);
            newLinks.push(disklyLink);
          } catch (err: any) {
            console.error(`Error processing Terabox link ${url}:`, err);
            ctx.reply(`⚠️ Failed to convert Terabox link: ${url}\nError: ${err.message || err}`);
          }
        }
      } else if (uniqueDisklyUrls.length > 0) {
        // Diskly to Diskly conversion
        taskDetected = true;
        processingMsg = await ctx.reply(`🔄 Cloning ${uniqueDisklyUrls.length} Diskly link(s)...`);

        for (const url of uniqueDisklyUrls) {
          try {
            const disklyLink = await processDisklyLink(url, admin.id);
            replacedText = replacedText.split(url).join(disklyLink);
            newLinks.push(disklyLink);
          } catch (err: any) {
            console.error(`Error processing Diskly link ${url}:`, err);
            ctx.reply(`⚠️ Failed to convert Diskly link: ${url}`);
          }
        }
      } else if (isVideoAttached) {
        // Direct video file upload
        taskDetected = true;
        processingMsg = await ctx.reply(`⏳ Processing direct video upload...`);

        try {
          const video = messageObj.video;
          const { downloadKey, title } = await processVideoMessage(ctx, video, admin.id);
          const disklyLink = `https://diskly.in/${downloadKey}`;
          newLinks.push(disklyLink);
        } catch (err: any) {
          console.error('Error handling direct video upload:', err);
          if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
          }
          return ctx.reply(`❌ Direct upload failed: ${err.message || err}`);
        }
      }

      if (!taskDetected) {
        // No links or video found
        return ctx.reply('❌ No video file or valid links (Terabox/Diskly) found in your message.');
      }

      // Build the final caption/message text applying formatting rules
      let baseContent = '';
      if (admin.telegramKeepText) {
        baseContent = replacedText || newLinks.join('\n');
      } else {
        baseContent = newLinks.join('\n');
      }

      let finalCaption = baseContent;
      if (admin.telegramHeader) {
        finalCaption = `${admin.telegramHeader}\n\n${finalCaption}`;
      }
      if (admin.telegramFooter) {
        finalCaption = `${finalCaption}\n\n${admin.telegramFooter}`;
      }

      // Delete the temporary status message
      if (processingMsg) {
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
      }

      // Media Preservation check
      const hasMedia = 'video' in messageObj || 'photo' in messageObj || 'document' in messageObj || 'audio' in messageObj || 'animation' in messageObj;

      if (hasMedia) {
        // Return same media with the modified caption
        await ctx.copyMessage(ctx.chat.id, {
          caption: finalCaption,
          parse_mode: 'HTML'
        });
      } else {
        // Return text response
        await ctx.reply(finalCaption, {
          parse_mode: 'HTML'
        });
      }

    } catch (error: any) {
      console.error('Error processing incoming message:', error);
      ctx.reply(`❌ An error occurred while processing: ${error.message || error}`);
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

