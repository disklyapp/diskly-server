import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import prisma from '../config/prisma.js';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import { initBot } from './instance.js';
import { videoQueue } from './queue.js';

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

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
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

export const setupTelegramBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN is not set in .env. Telegram Bot will not start.');
    return null;
  }

  const bot = initBot(token);

  const linkingState = new Map<string, boolean>();

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
          `3. Use the command: <code>/link_account</code> (or <code>/link_account &lt;your_upload_id&gt;</code>)\n\n` +
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
    const telegramChatId = ctx.chat.id.toString();

    if (!arg) {
      // Method 1: Interactive Flow
      linkingState.set(telegramChatId, true);
      return ctx.reply('Please send your Upload ID to link your account.');
    }
    
    // Method 2: Direct Command
    try {
      const admin = await prisma.admin.findUnique({
        where: { telegramUploadId: arg }
      });
      
      if (!admin) {
        return ctx.reply(`❌ <b>Invalid Upload ID.</b> Please check your admin dashboard and try again.`, { parse_mode: 'HTML' });
      }
      
      await prisma.admin.update({
        where: { id: admin.id },
        data: { telegramChatId }
      });
      
      linkingState.delete(telegramChatId);
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
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account</code>.`, { parse_mode: 'HTML' });
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
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account</code>.`, { parse_mode: 'HTML' });
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
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account</code>.`, { parse_mode: 'HTML' });
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
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account</code>.`, { parse_mode: 'HTML' });
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
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account</code>.`, { parse_mode: 'HTML' });
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
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account</code>.`, { parse_mode: 'HTML' });
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
    try {
      const admin = await getLinkedAdmin(ctx.chat.id.toString());
      if (!admin) {
        return ctx.reply(`❌ <b>Your account is not linked.</b> Please link it first using <code>/link_account</code>.`, { parse_mode: 'HTML' });
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
        `📈 <b>Today's Uploads:</b> ${todayVideos} / ${admin.dailyUploadLimit !== null ? admin.dailyUploadLimit : 'Unlimited'}\n\n` +
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

      // Extract raw text or caption from incoming message
      const rawText = ('text' in messageObj ? messageObj.text : 'caption' in messageObj ? messageObj.caption : '') || '';
      
      // Ignore if it's a command, but cancel interactive linking state
      if (rawText.trim().startsWith('/')) {
        linkingState.delete(telegramChatId);
        return;
      }

      // Check if user is in linking state
      if (linkingState.get(telegramChatId)) {
        const uploadId = rawText.trim();
        try {
          const admin = await prisma.admin.findUnique({
            where: { telegramUploadId: uploadId }
          });
          
          if (!admin) {
            return ctx.reply(`❌ <b>Invalid Upload ID.</b> Please send a valid Upload ID, or send /start to cancel.`, { parse_mode: 'HTML' });
          }
          
          await prisma.admin.update({
            where: { id: admin.id },
            data: { telegramChatId }
          });
          
          linkingState.delete(telegramChatId);
          return ctx.reply(`✅ <b>Successfully linked to account:</b> <code>${admin.email}</code>`, { parse_mode: 'HTML' });
        } catch (error) {
          console.error('Error linking account interactively:', error);
          return ctx.reply(`❌ <b>An error occurred during account linking.</b>`, { parse_mode: 'HTML' });
        }
      }

      const admin = await getLinkedAdmin(telegramChatId);

      if (!admin) {
        return ctx.reply(`❌ Your account is not linked. Please use <code>/link_account</code> to link your account first.`, { parse_mode: 'HTML' });
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

      if (uniqueTeraboxUrls.length === 0 && uniqueDisklyUrls.length === 0 && !isVideoAttached) {
        return ctx.reply('❌ No video file or valid links (Terabox/Diskly) found in your message.');
      }

      // Queue limit check (allow max 3 active jobs per user)
      try {
        const activeJobs = await videoQueue.getActive();
        const waitingJobs = await videoQueue.getWaiting();
        const adminJobsCount = [...activeJobs, ...waitingJobs].filter(
          job => job.data && job.data.adminId === admin.id
        ).length;

        if (adminJobsCount >= 3) {
          return ctx.reply('You can process a maximum of 3 files at a time. Please wait until your current files finish processing before submitting more files.');
        }
      } catch (err) {
        console.error('Failed to check queue limits:', err);
      }

      // Early daily upload limit verification
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const videosToday = await prisma.video.count({
        where: { adminId: admin.id, createdAt: { gte: today } }
      });

      if (uniqueTeraboxUrls.length > 0) {
        if (admin.dailyUploadLimit !== null && videosToday + uniqueTeraboxUrls.length > admin.dailyUploadLimit) {
          return ctx.reply(`❌ Daily upload limit exceeded. You can only upload ${admin.dailyUploadLimit - videosToday} more video(s) today.`);
        }

        const downloadKeys = uniqueTeraboxUrls.map(() => nanoid(10));
        const newLinks = downloadKeys.map(key => `https://diskly.in/${key}`);
        let replacedText = rawText;
        for (let i = 0; i < uniqueTeraboxUrls.length; i++) {
          replacedText = replacedText.split(uniqueTeraboxUrls[i]).join(newLinks[i]);
        }

        const hasMedia = 'video' in messageObj || 'photo' in messageObj || 'document' in messageObj || 'audio' in messageObj || 'animation' in messageObj;
        const statusMsg = await ctx.reply(`⏳ <b>Added to queue:</b> Processing ${uniqueTeraboxUrls.length} Terabox link(s)...`, { parse_mode: 'HTML' });

        await videoQueue.add('terabox-upload', {
          type: 'terabox',
          chatId: telegramChatId,
          messageId: messageObj.message_id,
          processingMessageId: statusMsg.message_id,
          urls: uniqueTeraboxUrls,
          adminId: admin.id,
          downloadKeys,
          replacedText,
          hasMedia
        });

      } else if (uniqueDisklyUrls.length > 0) {
        if (admin.dailyUploadLimit !== null && videosToday + uniqueDisklyUrls.length > admin.dailyUploadLimit) {
          return ctx.reply(`❌ Daily upload limit exceeded. You can only upload ${admin.dailyUploadLimit - videosToday} more video(s) today.`);
        }

        const processingMsg = await ctx.reply(`🔄 Cloning ${uniqueDisklyUrls.length} Diskly link(s)...`);
        const newLinks: string[] = [];
        let replacedText = rawText;

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

        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

        const hasMedia = 'video' in messageObj || 'photo' in messageObj || 'document' in messageObj || 'audio' in messageObj || 'animation' in messageObj;
        if (hasMedia) {
          await ctx.copyMessage(ctx.chat.id, {
            caption: finalCaption,
            parse_mode: 'HTML'
          });
        } else {
          await ctx.reply(finalCaption, {
            parse_mode: 'HTML'
          });
        }

      } else if (isVideoAttached) {
        if (admin.dailyUploadLimit !== null && videosToday >= admin.dailyUploadLimit) {
          return ctx.reply('❌ You have reached your daily upload limit.');
        }

        const fileSize = messageObj.video.file_size || 0;
        if (fileSize > 0) {
          const adminMaxTelegram = admin.maxUploadSizeTelegram ?? 0;
          let limitMb = adminMaxTelegram;
          if (limitMb <= 0) {
            const setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
            limitMb = setting?.defaultMaxUploadSizeTelegram || 200;
          }
          const limitBytes = limitMb * 1024 * 1024;
          if (fileSize > limitBytes) {
            const fileStr = formatSize(fileSize);
            const limitStr = formatSize(limitBytes);
            return ctx.reply(`❌ This file is ${fileStr}. The current supported upload limit is ${limitStr}.`);
          }
        }

        const downloadKey = nanoid(10);
        const fileName = messageObj.video.file_name || 'Telegram Upload';
        const statusMsg = await ctx.reply(`⏳ <b>Added to queue:</b> Processing direct video upload...`, { parse_mode: 'HTML' });

        await videoQueue.add('video-upload', {
          type: 'video',
          chatId: telegramChatId,
          messageId: messageObj.message_id,
          processingMessageId: statusMsg.message_id,
          downloadKey,
          adminId: admin.id,
          fileName
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

