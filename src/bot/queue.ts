import { Queue, Worker, Job } from 'bullmq';
import { workerConnection, queueConnection } from '../config/redis.js';
import prisma from '../config/prisma.js';
import { s3 } from '../config/b2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { gramjsClient } from './gramjs.js';
import { bot } from './instance.js';
import fs from 'fs';
import path from 'path';

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
};

const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

import { normalizeVideoFormat, transcodeToStreamableMp4, extractThumbnail } from '../utils/ffmpeg.js';
export { normalizeVideoFormat };

export const videoQueue = new Queue('video-processing', {
  connection: queueConnection as any,
});

export const videoWorker = new Worker(
  'video-processing',
  async (job: Job) => {
    const { type, chatId, messageId, processingMessageId, adminId } = job.data;

    let lastStatusText = '';
    const updateStatus = async (text: string) => {
      if (text === lastStatusText) return;
      try {
        await bot.telegram.editMessageText(chatId, processingMessageId, undefined, text, { parse_mode: 'HTML' });
        lastStatusText = text;
      } catch (err: any) {
        if (err.description && err.description.includes('message is not modified')) {
          lastStatusText = text; // Sync cache
          return;
        }
        console.error('Failed to update status message in telegram:', err);
      }
    };

    if (type === 'video') {
      const { downloadKey, fileName } = job.data;
      
      try {
        await updateStatus('⏳ <b>Connecting to Telegram...</b>');

        // Fetch the message from Telegram using GramJS
        const messages = await gramjsClient.getMessages(chatId, { ids: [messageId] });
        const message = messages[0];
        if (!message || !message.media) {
          throw new Error('Video message or media not found in Telegram.');
        }

        let normalized = normalizeVideoFormat('', job.data?.fileName);
        let ext = normalized.ext;
        let mimeType = normalized.mimeType;
        const media = message.media as any;
        if (media && media.document) {
          const rawMime = media.document.mimeType || 'video/mp4';
          let origFileName = '';
          if (Array.isArray(media.document.attributes)) {
            const fileAttr = media.document.attributes.find((attr: any) => attr.fileName);
            if (fileAttr) origFileName = fileAttr.fileName;
          }
          normalized = normalizeVideoFormat(rawMime, origFileName || (job.data && job.data.fileName));
          ext = normalized.ext;
          mimeType = normalized.mimeType;

          // Validate size limit before downloading
          const fileSize = Number(media.document.size || 0);
          if (fileSize > 0) {
            const admin = await prisma.admin.findUnique({ where: { id: adminId } });
            const setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
            const maxFileMb = admin?.maxFileSizeMb ?? setting?.defaultMaxFileSizeMb ?? 2000;
            const limitBytes = maxFileMb * 1024 * 1024;
            if (fileSize > limitBytes) {
              throw new Error(`This file is ${formatSize(fileSize)}. The maximum allowed file size is ${formatSize(limitBytes)}.`);
            }

            const allowedStorageGb = admin?.maxStorageGb !== undefined && admin?.maxStorageGb !== null
              ? admin.maxStorageGb
              : (setting?.defaultMaxStorageGb ?? null);

            if (allowedStorageGb !== null && allowedStorageGb > 0) {
              const storageAgg = await prisma.video.aggregate({
                where: { adminId },
                _sum: { size: true }
              });
              const usedBytes = (admin?.customStorageGb !== null && admin?.customStorageGb !== undefined)
                ? Math.round(admin.customStorageGb * 1024 * 1024 * 1024)
                : (storageAgg._sum.size || 0);
              const maxStorageBytes = allowedStorageGb * 1024 * 1024 * 1024;

              if (usedBytes >= maxStorageBytes) {
                const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
                throw new Error(`Storage quota full! You have consumed ${usedGb} GB of ${allowedStorageGb} GB allowed. Uploading more videos is disabled.`);
              }

              if (usedBytes + fileSize > maxStorageBytes) {
                const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
                const fileGb = (fileSize / (1024 * 1024 * 1024)).toFixed(2);
                throw new Error(`Storage limit exceeded! Current usage: ${usedGb} GB. Uploading this file (${fileGb} GB) exceeds your quota of ${allowedStorageGb} GB.`);
              }
            }
          }
        }

        const objectKey = `${downloadKey}.${ext}`;
        const localFilePath = path.join(uploadDir, objectKey);

        await updateStatus('⏳ <b>Downloading video from Telegram (0%)...</b>');

        let lastUpdateTime = 0;
        await gramjsClient.downloadMedia(message.media, {
          outputFile: localFilePath,
          workers: 4,
          progressCallback: (downloaded: any, total: any) => {
            const now = Date.now();
            if (now - lastUpdateTime > 4000 && total) {
              lastUpdateTime = now;
              const percent = Math.round((Number(downloaded) / Number(total)) * 100);
              updateStatus(`⏳ <b>Downloading video from Telegram:</b> ${percent}%`).catch(() => {});
            }
          },
        } as any);

        await updateStatus('⏳ <b>Extracting thumbnail...</b>');
        let thumbObjectKey = '';
        let localThumbPath = '';
        try {
          const thumbBuffer = await gramjsClient.downloadMedia(message.media, {
            thumb: 0,
          } as any);
          if (thumbBuffer) {
            thumbObjectKey = `${downloadKey}_thumb.jpg`;
            localThumbPath = path.join(uploadDir, thumbObjectKey);
            fs.writeFileSync(localThumbPath, thumbBuffer);
          }
        } catch (err) {
          console.error('Failed to download video thumbnail via GramJS:', err);
        }

        let finalFilePath = localFilePath;
        let finalObjectKey = objectKey;
        let finalMimeType = mimeType;

        if (normalized.needsTranscoding) {
          await updateStatus('⚙️ <b>Optimizing & transcoding to streamable MP4...</b>');
          const transcodedKey = `${downloadKey}.mp4`;
          const transcodedPath = path.join(uploadDir, transcodedKey);
          try {
            await transcodeToStreamableMp4(localFilePath, transcodedPath, (pct) => {
              updateStatus(`⚙️ <b>Transcoding video:</b> ${pct}%`).catch(() => {});
            });
            if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
            finalFilePath = transcodedPath;
            finalObjectKey = transcodedKey;
            finalMimeType = 'video/mp4';
          } catch (transcodeErr) {
            console.warn('Transcoding fallback to original file:', transcodeErr);
          }
        }

        await updateStatus('📤 <b>Uploading to Diskly Server...</b>');

        const fileStream = fs.createReadStream(finalFilePath);
        const videoUpload = new Upload({
          client: s3,
          params: {
            Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
            Key: finalObjectKey,
            Body: fileStream,
            ContentType: finalMimeType,
          },
          queueSize: 4,
          partSize: 5 * 1024 * 1024,
          leavePartsOnError: false,
        });

        const uploadPromises = [videoUpload.done()];

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
          streamUrl = `${domain.replace(/\/$/, '')}/${finalObjectKey}`;
          if (localThumbPath) finalThumbnailUrl = `${domain.replace(/\/$/, '')}/${thumbObjectKey}`;
        } else {
          streamUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${finalObjectKey}`;
          if (localThumbPath) finalThumbnailUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${thumbObjectKey}`;
        }

        const mediaObj = message.media as any;
        const fileSize = fs.existsSync(finalFilePath)
          ? fs.statSync(finalFilePath).size
          : ((mediaObj && mediaObj.document) ? Number(mediaObj.document.size) : 0);

        await prisma.video.create({
          data: {
            title: fileName || 'Telegram Upload',
            description: 'NA',
            streamUrl,
            downloadKey,
            thumbnailUrl: finalThumbnailUrl,
            size: fileSize,
            adminId,
          },
        });

        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        if (localThumbPath && fs.existsSync(localThumbPath)) fs.unlinkSync(localThumbPath);

        const admin = await prisma.admin.findUnique({ where: { id: adminId } });
        if (!admin) throw new Error('Admin not found');

        const disklyLink = `https://diskly.in/${downloadKey}`;
        let finalCaption = disklyLink;
        if (admin.telegramKeepText && fileName) {
          finalCaption = `${fileName}\n\n${finalCaption}`;
        }
        if (admin.telegramHeader) {
          finalCaption = `${admin.telegramHeader}\n\n${finalCaption}`;
        }
        if (admin.telegramFooter) {
          finalCaption = `${finalCaption}\n\n${admin.telegramFooter}`;
        }

        await bot.telegram.deleteMessage(chatId, processingMessageId).catch(() => {});
        if (finalThumbnailUrl) {
          await bot.telegram.sendPhoto(chatId, finalThumbnailUrl, {
            caption: finalCaption,
            parse_mode: 'HTML',
          });
        } else {
          await bot.telegram.sendMessage(chatId, finalCaption, {
            parse_mode: 'HTML',
          });
        }

      } catch (err: any) {
        console.error('Error handling direct video upload in background job:', err);
        await updateStatus(`❌ <b>Direct upload failed:</b> ${err.message || err}`);
      }

    } else if (type === 'terabox') {
      const { urls, downloadKeys, replacedText, hasMedia } = job.data;
      let finalText = replacedText;
      const newLinks: string[] = [];

      try {
        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          const downloadKey = downloadKeys[i];

          await updateStatus(`⏳ <b>Fetching details from Terabox [${i + 1}/${urls.length}]...</b>`);

          const response = await fetch('https://xapiverse.com/api/terabox', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xAPIverse-Key': process.env.TERABOX_API_KEY || '',
            },
            body: JSON.stringify({ url }),
          });

          const data = await response.json();
          if (data.status !== 'success' || !data.list || data.list.length === 0) {
            throw new Error(`Failed to fetch video from Terabox link: ${url}`);
          }

          const fileInfo = data.list[0];
          const downloadUrl = fileInfo.normal_dlink || fileInfo.stream_url || fileInfo.fast_stream_url?.['1080p'] || fileInfo.fast_stream_url?.['720p'];

          if (!downloadUrl) {
            throw new Error(`Could not find a valid download link from Terabox.`);
          }

          // Validate size limit before downloading Terabox video
          const fileSize = fileInfo.size ? Number(fileInfo.size) : 0;
          if (fileSize > 0) {
            const admin = await prisma.admin.findUnique({ where: { id: adminId } });
            const setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
            const maxFileMb = admin?.maxFileSizeMb ?? setting?.defaultMaxFileSizeMb ?? 2000;
            const limitBytes = maxFileMb * 1024 * 1024;
            if (fileSize > limitBytes) {
              throw new Error(`This file is ${formatSize(fileSize)}. The maximum allowed file size is ${formatSize(limitBytes)}.`);
            }

            const allowedStorageGb = admin?.maxStorageGb !== undefined && admin?.maxStorageGb !== null
              ? admin.maxStorageGb
              : (setting?.defaultMaxStorageGb ?? null);

            if (allowedStorageGb !== null && allowedStorageGb > 0) {
              const storageAgg = await prisma.video.aggregate({
                where: { adminId },
                _sum: { size: true }
              });
              const usedBytes = (admin?.customStorageGb !== null && admin?.customStorageGb !== undefined)
                ? Math.round(admin.customStorageGb * 1024 * 1024 * 1024)
                : (storageAgg._sum.size || 0);
              const maxStorageBytes = allowedStorageGb * 1024 * 1024 * 1024;

              if (usedBytes >= maxStorageBytes) {
                const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
                throw new Error(`Storage quota full! You have consumed ${usedGb} GB of ${allowedStorageGb} GB allowed. Uploading more videos is disabled.`);
              }

              if (usedBytes + fileSize > maxStorageBytes) {
                const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
                const fileGb = (fileSize / (1024 * 1024 * 1024)).toFixed(2);
                throw new Error(`Storage limit exceeded! Current usage: ${usedGb} GB. Uploading this file (${fileGb} GB) exceeds your quota of ${allowedStorageGb} GB.`);
              }
            }
          }

          await updateStatus(`⏳ <b>Downloading Terabox video [${i + 1}/${urls.length}]...</b>`);

          const normalized = normalizeVideoFormat('', fileInfo.name);
          const objectKey = `${downloadKey}.${normalized.ext}`;
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
              console.error('Failed to download terabox thumbnail', err);
            }
          }

          await updateStatus(`📤 <b>Uploading Terabox video to Diskly Server [${i + 1}/${urls.length}]...</b>`);

          const fileStream = fs.createReadStream(localFilePath);
          const videoUpload = new Upload({
            client: s3,
            params: {
              Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
              Key: objectKey,
              Body: fileStream,
              ContentType: normalized.mimeType,
            },
            queueSize: 4,
            partSize: 5 * 1024 * 1024,
            leavePartsOnError: false,
          });

          const uploadPromises = [videoUpload.done()];

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
              title: fileInfo.name || 'Terabox Video',
              description: 'NA',
              streamUrl,
              downloadKey,
              thumbnailUrl: finalThumbnailUrl,
              size: buffer.length,
              adminId,
            },
          });

          if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
          if (localThumbPath && fs.existsSync(localThumbPath)) fs.unlinkSync(localThumbPath);

          const disklyLink = `https://diskly.in/${downloadKey}`;
          finalText = finalText.split(url).join(disklyLink);
          newLinks.push(disklyLink);
        }

        await bot.telegram.deleteMessage(chatId, processingMessageId).catch(() => {});

        const admin = await prisma.admin.findUnique({ where: { id: adminId } });
        if (!admin) throw new Error('Admin not found');

        let baseContent = '';
        if (admin.telegramKeepText) {
          baseContent = finalText || newLinks.join('\n');
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

        if (hasMedia && messageId) {
          await bot.telegram.copyMessage(chatId, chatId, messageId, {
            caption: finalCaption,
            parse_mode: 'HTML',
          });
        } else {
          await bot.telegram.sendMessage(chatId, finalCaption, {
            parse_mode: 'HTML',
          });
        }

      } catch (err: any) {
        console.error('Error handling Terabox links in background job:', err);
        await updateStatus(`❌ <b>Terabox processing failed:</b> ${err.message || err}`);
      }
    }
  },
  {
    connection: workerConnection as any,
    concurrency: 2, // Process up to 2 files simultaneously to manage bandwidth/RAM
  }
);

videoWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed with error:`, err);
});

videoWorker.on('error', (err) => {
  console.error('Queue Worker Error (e.g. Redis limit reached):', err);
});

videoQueue.on('error', (err) => {
  console.error('Queue Error (e.g. Redis limit reached):', err);
});
