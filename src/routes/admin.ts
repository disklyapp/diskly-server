import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import prisma from '../config/prisma.js';
import { adminAuth } from '../middleware/auth.js';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import path from 'path';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
}

const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: `${uploadDir}/` });

const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY || '',
  },
});

const router = Router();

// Helper to generate unique 5-10 digit random ID (using 8 digits)
async function generateUniqueShareId(): Promise<string> {
  let shareId = '';
  let exists = true;
  while (exists) {
    shareId = Math.floor(10000000 + Math.random() * 90000000).toString();
    const admin = await prisma.admin.findUnique({ where: { shareId } });
    if (!admin) {
      exists = false;
    }
  }
  return shareId;
}

// Register
router.post('/register', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  try {
    const existing = await prisma.admin.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already in use' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const telegramUploadId = nanoid(10);
    const shareId = await generateUniqueShareId();
    const admin = await prisma.admin.create({
      data: { email, password: hashedPassword, telegramUploadId, shareId }
    });

    res.json({ message: 'Admin registered successfully' });
  } catch (error: any) {
    console.error('Error during admin registration:', error);
    res.status(500).json({ error: 'Failed to register admin', details: error?.message || String(error) });
  }
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  try {
    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) return res.status(400).json({ error: 'Invalid credentials' });
    if (!admin.isActive) return res.status(403).json({ error: 'Account has been deactivated' });

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ adminId: admin.id }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '1d' });
    res.json({ token, admin: { email: admin.email, balance: admin.balance } });
  } catch (error: any) {
    console.error('Error during admin login:', error);
    res.status(500).json({ error: 'Failed to login admin', details: error?.message || String(error) });
  }
});

// Google Login / Signup
router.post('/google-login', async (req: Request, res: Response) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'ID Token is required' });

  try {
    // Verify token with Google's tokeninfo API
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!response.ok) {
      return res.status(400).json({ error: 'Invalid Google token' });
    }

    const payload = await response.json();
    const { email, name, picture, email_verified, aud } = payload;

    if (email_verified !== true && email_verified !== 'true') {
      return res.status(400).json({ error: 'Google email is not verified' });
    }

    // Verify Audience (Client ID) if configured in environment
    const expectedClientId = process.env.GOOGLE_CLIENT_ID;
    if (expectedClientId && aud !== expectedClientId) {
      return res.status(400).json({ error: 'Invalid token audience (Client ID mismatch)' });
    }

    let admin = await prisma.admin.findUnique({ where: { email } });

    if (admin) {
      // Login existing user
      if (!admin.isActive) return res.status(403).json({ error: 'Account has been deactivated' });
      
      // Optionally update name/profilePic if they changed or were empty
      if (!admin.name || !admin.profilePic) {
        admin = await prisma.admin.update({
          where: { id: admin.id },
          data: {
            name: admin.name || name,
            profilePic: admin.profilePic || picture
          }
        });
      }
    } else {
      // Auto-signup new user
      const randomPassword = nanoid(20);
      const hashedPassword = await bcrypt.hash(randomPassword, 10);
      const telegramUploadId = nanoid(10);
      const shareId = await generateUniqueShareId();
      
      admin = await prisma.admin.create({
        data: {
          email,
          password: hashedPassword,
          name: name || null,
          profilePic: picture || null,
          telegramUploadId,
          shareId
        }
      });
    }

    const token = jwt.sign({ adminId: admin.id }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '1d' });
    res.json({ token, admin: { email: admin.email, balance: admin.balance } });
  } catch (error: any) {
    console.error('Error during Google authentication:', error);
    res.status(500).json({ error: 'Google authentication failed', details: error?.message || String(error) });
  }
});

// Protected routes below
router.use(adminAuth);

// Dashboard
router.get('/dashboard', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    let admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    if (!admin.shareId) {
      const shareId = await generateUniqueShareId();
      admin = await prisma.admin.update({
        where: { id: adminId },
        data: { shareId }
      });
    }

    const totalFiles = await prisma.video.count({ where: { adminId } });
    const engagements = await prisma.video.aggregate({
      where: { adminId },
      _sum: { views: true, likes: true }
    });

    res.json({
      balance: admin.balance,
      totalEarnings: admin.totalEarnings,
      totalFiles,
      clicksAndViews: engagements._sum.views || 0,
      likes: engagements._sum.likes || 0,
      telegramUploadId: admin.telegramUploadId,
      shareId: admin.shareId
    });
  } catch (error: any) {
    console.error('Error fetching admin dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data', details: error?.message || String(error) });
  }
});

// Analytics
router.get('/analytics', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      include: {
        payouts: true,
        videos: {
          select: {
            createdAt: true
          }
        }
      }
    });

    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    // Calculate money fields
    const availableMoney = admin.balance;
    let paidMoney = 0;
    let pendingMoney = 0;
    let approvedMoney = 0;
    let cancelledMoney = 0;

    for (const p of admin.payouts) {
      if (p.status === 'COMPLETED') {
        paidMoney += p.amount;
      } else if (p.status === 'PENDING') {
        pendingMoney += p.amount;
      } else if (p.status === 'APPROVED') {
        approvedMoney += p.amount;
      } else if (p.status === 'CANCELLED' || p.status === 'REJECTED') {
        cancelledMoney += p.amount;
      }
    }

    const totalWalletBalance = availableMoney + pendingMoney + approvedMoney + paidMoney;

    // Get all daily analytics
    const dailyAnalytics = await prisma.dailyAnalytic.findMany({
      where: { adminId },
      orderBy: { date: 'asc' }
    });

    // Count uploaded files for each day
    const videosByDay: Record<string, number> = {};
    for (const video of admin.videos) {
      const dateStr = video.createdAt.toISOString().split('T')[0];
      videosByDay[dateStr] = (videosByDay[dateStr] || 0) + 1;
    }

    // Map daily analytics to include uploaded files
    const dailyData = dailyAnalytics.map(d => {
      const dateStr = d.date.toISOString().split('T')[0];
      return {
        date: dateStr,
        views: d.views,
        likes: d.likes,
        linkEarnings: d.earnings,
        totalEarnings: d.earnings,
        uploadedFiles: videosByDay[dateStr] || 0
      };
    });

    res.json({
      money: {
        totalWalletBalance,
        paid: paidMoney,
        available: availableMoney,
        approved: approvedMoney,
        pending: pendingMoney,
        cancelled: cancelledMoney
      },
      daily: dailyData,
      adminCreatedAt: admin.createdAt
    });
  } catch (error: any) {
    console.error('Error fetching admin analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics', details: error?.message || String(error) });
  }
});

// Get Payout requests for Admin
router.get('/payouts', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    const payouts = await prisma.payoutRequest.findMany({
      where: { adminId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(payouts);
  } catch (error: any) {
    console.error('Error fetching admin payouts:', error);
    res.status(500).json({ error: 'Failed to fetch payouts', details: error?.message || String(error) });
  }
});

// Request Payout
router.post('/payouts', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { amount, paymentMethod, paymentDetails } = req.body;

  try {
    let setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
    const minimumThreshold = setting?.minimumPayoutThreshold || 10.0;

    if (amount < minimumThreshold) {
      return res.status(400).json({ error: `Minimum payout is $${minimumThreshold}` });
    }

    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin || admin.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct balance and create request
    await prisma.$transaction([
      prisma.admin.update({
        where: { id: adminId },
        data: { balance: { decrement: amount } }
      }),
      prisma.payoutRequest.create({
        data: { adminId, amount, paymentMethod, paymentDetails, status: 'PENDING' }
      })
    ]);

    res.json({ message: 'Payout requested successfully' });
  } catch (error: any) {
    console.error('Error requesting payout:', error);
    res.status(500).json({ error: 'Failed to request payout', details: error?.message || String(error) });
  }
});

// Get Admin Videos
router.get('/videos', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    const videos = await prisma.video.findMany({
      where: { adminId },
      include: { admin: { select: { name: true, profilePic: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(videos);
  } catch (error: any) {
    console.error('Error fetching admin videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos', details: error?.message || String(error) });
  }
});

// Get Single Video
router.get('/videos/:id', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const videoId = Number(req.params.id);
  try {
    const video = await prisma.video.findFirst({
      where: { id: videoId, adminId },
      include: { admin: { select: { name: true, profilePic: true } } }
    });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.json(video);
  } catch (error: any) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Failed to fetch video', details: error?.message || String(error) });
  }
});

// Delete Video
router.delete('/videos/:id', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const videoId = Number(req.params.id);
  try {
    const video = await prisma.video.findFirst({
      where: { id: videoId, adminId }
    });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Optional: Delete from B2 here (requires deleteObject command)
    // For now, just delete from DB
    await prisma.video.delete({ where: { id: videoId } });
    res.json({ message: 'Video deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video', details: error?.message || String(error) });
  }
});

// Get Telegram API Key
router.get('/telegram/api-key', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json({ key: admin.telegramUploadId });
  } catch (error: any) {
    console.error('Error fetching telegram key:', error);
    res.status(500).json({ error: 'Failed to fetch telegram key', details: error?.message || String(error) });
  }
});

// Regenerate Telegram API Key
router.put('/telegram/api-key', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key is required' });

  try {
    const admin = await prisma.admin.update({
      where: { id: adminId },
      data: { telegramUploadId: key }
    });
    res.json({ key: admin.telegramUploadId });
  } catch (error: any) {
    console.error('Error updating telegram key:', error);
    res.status(500).json({ error: 'Failed to update telegram key', details: error?.message || String(error) });
  }
});

const chunksDir = path.join(uploadDir, 'chunks');
if (!fs.existsSync(chunksDir)) {
  fs.mkdirSync(chunksDir, { recursive: true });
}

// Initialize Chunked Upload
router.post('/videos/chunk/init', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { title, filename, fileSize } = req.body;

  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    // Check size limit
    let limitMb = admin.maxUploadSizeWebsite;
    if (limitMb === null || limitMb === undefined) {
      const setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
      limitMb = setting?.defaultMaxUploadSizeWebsite || 500;
    }
    const limitBytes = limitMb * 1024 * 1024;
    if (fileSize && Number(fileSize) > limitBytes) {
      return res.status(400).json({ error: `Video size exceeds the maximum limit of ${limitMb} MB.` });
    }

    // Check daily / monthly limits
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (admin.dailyUploadLimit !== null && admin.dailyUploadLimit !== undefined) {
      const videosToday = await prisma.video.count({
        where: { adminId, createdAt: { gte: today } }
      });
      if (videosToday >= admin.dailyUploadLimit) {
        return res.status(400).json({ error: 'Daily upload limit reached' });
      }
    }

    if (admin.monthlyUploadLimit !== null && admin.monthlyUploadLimit !== undefined) {
      const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const videosThisMonth = await prisma.video.count({
        where: { adminId, createdAt: { gte: firstDayOfMonth } }
      });
      if (videosThisMonth >= admin.monthlyUploadLimit) {
        return res.status(400).json({ error: 'Monthly upload limit reached' });
      }
    }

    const uploadId = nanoid(12);
    const adminChunksDir = path.join(chunksDir, uploadId);
    if (!fs.existsSync(adminChunksDir)) {
      fs.mkdirSync(adminChunksDir, { recursive: true });
    }

    res.json({ uploadId });
  } catch (error: any) {
    console.error('Error initializing chunked upload:', error);
    res.status(500).json({ error: 'Failed to initialize upload', details: error?.message || String(error) });
  }
});

// Upload Chunk
router.post('/videos/chunk/upload', upload.single('video'), async (req: Request, res: Response) => {
  const { uploadId, chunkIndex } = req.body;
  const file = req.file;

  if (!uploadId || chunkIndex === undefined || !file) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'Missing uploadId, chunkIndex, or file' });
  }

  try {
    const adminChunksDir = path.join(chunksDir, uploadId);
    if (!fs.existsSync(adminChunksDir)) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Invalid or expired upload session' });
    }

    const chunkPath = path.join(adminChunksDir, String(chunkIndex));
    fs.renameSync(file.path, chunkPath);

    res.json({ success: true });
  } catch (error: any) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error('Error uploading chunk:', error);
    res.status(500).json({ error: 'Failed to upload chunk', details: error?.message || String(error) });
  }
});

// Complete Chunked Upload
router.post('/videos/chunk/complete', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { uploadId, title, filename, totalChunks, description } = req.body;

  if (!uploadId || !totalChunks) {
    return res.status(400).json({ error: 'Missing uploadId or totalChunks' });
  }

  const adminChunksDir = path.join(chunksDir, uploadId);
  const mergedFilePath = path.join(uploadDir, `${uploadId}_merged.mp4`);
  let thumbPath = '';

  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    if (!fs.existsSync(adminChunksDir)) {
      return res.status(400).json({ error: 'Upload session not found' });
    }

    // Check that all chunks are present
    const chunksCount = Number(totalChunks);
    for (let i = 0; i < chunksCount; i++) {
      const chunkPath = path.join(adminChunksDir, String(i));
      if (!fs.existsSync(chunkPath)) {
        return res.status(400).json({ error: `Missing chunk ${i}` });
      }
    }

    // Merge chunks
    const writeStream = fs.createWriteStream(mergedFilePath);
    for (let i = 0; i < chunksCount; i++) {
      const chunkPath = path.join(adminChunksDir, String(i));
      const chunkBuffer = fs.readFileSync(chunkPath);
      writeStream.write(chunkBuffer);
      fs.unlinkSync(chunkPath); // Delete chunk after writing
    }
    writeStream.end();

    // Wait for the file to be fully written
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', (err) => reject(err));
    });

    // Clean up chunk directory
    fs.rmdirSync(adminChunksDir);

    const mergedStats = fs.statSync(mergedFilePath);

    const downloadKey = nanoid(10);
    const fileExtension = filename ? filename.split('.').pop() : 'mp4';
    const objectKey = `${downloadKey}.${fileExtension}`;
    const thumbObjectKey = `${downloadKey}_thumb.png`;
    thumbPath = path.join(uploadDir, thumbObjectKey);

    // Extract Thumbnail using fluent-ffmpeg
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(mergedFilePath)
          .screenshots({
            timestamps: ['00:00:01.000'],
            filename: thumbObjectKey,
            folder: uploadDir,
            size: '320x240'
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
    } catch (ffmpegErr) {
      console.error('Failed to generate thumbnail via ffmpeg:', ffmpegErr);
    }

    // Upload to Backblaze B2 (Video)
    const fileStream = fs.createReadStream(mergedFilePath);
    const uploadParams = {
      Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
      Key: objectKey,
      Body: fileStream,
      ContentType: 'video/mp4',
    };

    // Upload to Backblaze B2 (Thumbnail)
    let thumbUploadParams: any = null;
    if (fs.existsSync(thumbPath)) {
      const thumbStream = fs.createReadStream(thumbPath);
      thumbUploadParams = {
        Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
        Key: thumbObjectKey,
        Body: thumbStream,
        ContentType: 'image/png',
      };
    }

    try {
      const uploadPromises = [s3.send(new PutObjectCommand(uploadParams))];
      if (thumbUploadParams) {
        uploadPromises.push(s3.send(new PutObjectCommand(thumbUploadParams)));
      }
      await Promise.all(uploadPromises);
    } catch (s3Error: any) {
      console.error('Detailed B2 Upload Error:', s3Error);
      if (fs.existsSync(mergedFilePath)) fs.unlinkSync(mergedFilePath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      return res.status(500).json({ error: 'Failed to upload video to storage', details: s3Error?.message || String(s3Error) });
    }

    let streamUrl = '';
    let finalThumbnailUrl = '';
    const domain = process.env.CLOUDFLARE_DOMAIN || '';
    if (domain.includes('/file/')) {
      streamUrl = `${domain.replace(/\/$/, '')}/${objectKey}`;
      if (fs.existsSync(thumbPath)) finalThumbnailUrl = `${domain.replace(/\/$/, '')}/${thumbObjectKey}`;
    } else {
      streamUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${objectKey}`;
      if (fs.existsSync(thumbPath)) finalThumbnailUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${thumbObjectKey}`;
    }

    const video = await prisma.video.create({
      data: {
        title: title || filename || 'Untitled',
        description: description || '',
        streamUrl,
        downloadKey,
        thumbnailUrl: finalThumbnailUrl,
        size: mergedStats.size,
        adminId
      }
    });

    if (fs.existsSync(mergedFilePath)) fs.unlinkSync(mergedFilePath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    res.json(video);
  } catch (error: any) {
    if (fs.existsSync(mergedFilePath)) fs.unlinkSync(mergedFilePath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    if (fs.existsSync(adminChunksDir)) {
      try {
        fs.rmSync(adminChunksDir, { recursive: true, force: true });
      } catch (e) {}
    }
    console.error('Error completing chunked upload:', error);
    res.status(500).json({ error: 'Failed to complete upload', details: error?.message || String(error) });
  }
});

// Upload Video to Backblaze B2 (standard single request upload)
router.post('/videos', upload.single('video'), async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { thumbnailUrl, description } = req.body;
  let { title } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Video file is required. Make sure to use multipart/form-data with a "video" field.' });
  }

  if (!title) {
    title = file.originalname;
  }

  let thumbPath = '';
  try {
    // Check limits
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) {
      fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'Admin not found' });
    }

    // Check size limit
    let limitMb = admin.maxUploadSizeWebsite;
    if (limitMb === null || limitMb === undefined) {
      const setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
      limitMb = setting?.defaultMaxUploadSizeWebsite || 500;
    }
    const limitBytes = limitMb * 1024 * 1024;
    if (file.size > limitBytes) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: `Video size exceeds the maximum limit of ${limitMb} MB.` });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check daily upload limit
    if (admin.dailyUploadLimit !== null && admin.dailyUploadLimit !== undefined) {
      const videosToday = await prisma.video.count({
        where: { adminId, createdAt: { gte: today } }
      });
      if (videosToday >= admin.dailyUploadLimit) {
        fs.unlinkSync(file.path);
        return res.status(400).json({ error: 'Daily upload limit reached' });
      }
    }

    // Check monthly upload limit
    if (admin.monthlyUploadLimit !== null && admin.monthlyUploadLimit !== undefined) {
      const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const videosThisMonth = await prisma.video.count({
        where: { adminId, createdAt: { gte: firstDayOfMonth } }
      });
      if (videosThisMonth >= admin.monthlyUploadLimit) {
        fs.unlinkSync(file.path);
        return res.status(400).json({ error: 'Monthly upload limit reached' });
      }
    }

    const downloadKey = nanoid(10);
    const fileExtension = file.originalname.split('.').pop();
    const objectKey = `${downloadKey}.${fileExtension}`;
    const thumbObjectKey = `${downloadKey}_thumb.png`;
    thumbPath = path.join(uploadDir, thumbObjectKey);

    // Extract Thumbnail using fluent-ffmpeg
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(file.path)
          .screenshots({
            timestamps: ['00:00:01.000'],
            filename: thumbObjectKey,
            folder: uploadDir,
            size: '320x240'
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
    } catch (ffmpegErr) {
      console.error('Failed to generate thumbnail via ffmpeg:', ffmpegErr);
      // We can continue without thumbnail if it fails, or we can choose to fail the request.
      // Continuing is safer if ffmpeg isn't perfectly configured.
    }

    // Upload to Backblaze B2 (Video)
    const fileStream = fs.createReadStream(file.path);
    const uploadParams = {
      Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
      Key: objectKey,
      Body: fileStream,
      ContentType: file.mimetype,
    };

    // Upload to Backblaze B2 (Thumbnail)
    let thumbUploadParams: any = null;
    if (fs.existsSync(thumbPath)) {
      const thumbStream = fs.createReadStream(thumbPath);
      thumbUploadParams = {
        Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
        Key: thumbObjectKey,
        Body: thumbStream,
        ContentType: 'image/png',
      };
    }

    try {
      const uploadPromises = [s3.send(new PutObjectCommand(uploadParams))];
      if (thumbUploadParams) {
        uploadPromises.push(s3.send(new PutObjectCommand(thumbUploadParams)));
      }
      await Promise.all(uploadPromises);
    } catch (s3Error: any) {
      console.error('Detailed B2 Upload Error:', s3Error);
      fs.unlinkSync(file.path);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      return res.status(500).json({ error: 'Failed to upload video to storage', details: s3Error?.message || String(s3Error) });
    }

    let streamUrl = '';
    let finalThumbnailUrl = thumbnailUrl || '';
    const domain = process.env.CLOUDFLARE_DOMAIN || '';
    if (domain.includes('/file/')) {
      streamUrl = `${domain.replace(/\/$/, '')}/${objectKey}`;
      if (!thumbnailUrl && fs.existsSync(thumbPath)) finalThumbnailUrl = `${domain.replace(/\/$/, '')}/${thumbObjectKey}`;
    } else {
      streamUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${objectKey}`;
      if (!thumbnailUrl && fs.existsSync(thumbPath)) finalThumbnailUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${thumbObjectKey}`;
    }

    const video = await prisma.video.create({
      data: { title, description, streamUrl, downloadKey, thumbnailUrl: finalThumbnailUrl, size: file.size, adminId }
    });
    
    // Delete local temp files
    fs.unlinkSync(file.path);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    res.json(video);
  } catch (error: any) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    console.error('Error creating video:', error);
    res.status(500).json({ error: 'Failed to create video record', details: error?.message || String(error) });
  }
});

// Edit Video Title & Description
router.put('/videos/:id', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const videoId = Number(req.params.id);
  const { title, description } = req.body;
  
  try {
    const video = await prisma.video.findFirst({ where: { id: videoId, adminId } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const updatedVideo = await prisma.video.update({
      where: { id: videoId },
      data: { title, description }
    });
    res.json(updatedVideo);
  } catch (error: any) {
    console.error('Error updating video:', error);
    res.status(500).json({ error: 'Failed to update video', details: error?.message || String(error) });
  }
});

// Get Account info
router.get('/account', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    let admin = await prisma.admin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        name: true,
        profilePic: true,
        email: true,
        bankName: true,
        ifscCode: true,
        accountNumber: true,
        upiId: true,
        balance: true,
        shareId: true,
        maxUploadSizeWebsite: true,
        maxUploadSizeTelegram: true
      }
    });

    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    if (!admin.shareId) {
      const generatedShareId = await generateUniqueShareId();
      const updatedAdmin = await prisma.admin.update({
        where: { id: adminId },
        data: { shareId: generatedShareId },
        select: {
          id: true,
          name: true,
          profilePic: true,
          email: true,
          bankName: true,
          ifscCode: true,
          accountNumber: true,
          upiId: true,
          balance: true,
          shareId: true,
          maxUploadSizeWebsite: true,
          maxUploadSizeTelegram: true
        }
      });
      admin = updatedAdmin;
    }

    const setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
    const minimumPayoutThreshold = setting?.minimumPayoutThreshold || 10.0;

    res.json({
      ...admin,
      minimumPayoutThreshold
    });
  } catch (error: any) {
    console.error('Error fetching account:', error);
    res.status(500).json({ error: 'Failed to fetch account', details: error?.message || String(error) });
  }
});

// Update Account info
router.put('/account', upload.single('profilePic'), async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { name, bankName, ifscCode, accountNumber, upiId } = req.body;
  const file = req.file;
  
  let profilePicUrl = req.body.profilePicUrl;

  try {
    if (file) {
      const downloadKey = nanoid(10);
      const fileExtension = file.originalname.split('.').pop();
      const objectKey = `profile_${downloadKey}.${fileExtension}`;
      
      const fileStream = fs.createReadStream(file.path);
      const uploadParams = {
        Bucket: process.env.B2_BUCKET_NAME || 'disklyserver',
        Key: objectKey,
        Body: fileStream,
        ContentType: file.mimetype,
      };
      
      await s3.send(new PutObjectCommand(uploadParams));
      fs.unlinkSync(file.path);
      
      const domain = process.env.CLOUDFLARE_DOMAIN || '';
      if (domain.includes('/file/')) {
        profilePicUrl = `${domain.replace(/\/$/, '')}/${objectKey}`;
      } else {
        profilePicUrl = `https://${domain.replace(/\/$/, '')}/file/${process.env.B2_BUCKET_NAME}/${objectKey}`;
      }
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (profilePicUrl !== undefined) updateData.profilePic = profilePicUrl;
    if (bankName !== undefined) updateData.bankName = bankName;
    if (ifscCode !== undefined) updateData.ifscCode = ifscCode;
    if (accountNumber !== undefined) updateData.accountNumber = accountNumber;
    if (upiId !== undefined) updateData.upiId = upiId;

    const admin = await prisma.admin.update({
      where: { id: adminId },
      data: updateData,
      select: {
        name: true,
        profilePic: true,
        bankName: true,
        ifscCode: true,
        accountNumber: true,
        upiId: true
      }
    });

    res.json(admin);
  } catch (error: any) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error('Error updating account:', error);
    res.status(500).json({ error: 'Failed to update account', details: error?.message || String(error) });
  }
});

// Reports API for Admin
router.get('/reports', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const totalStats = await prisma.video.aggregate({
      where: { adminId },
      _sum: { views: true, bookmarks: true }
    });

    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyStats = await prisma.dailyAnalytic.aggregate({
      where: { adminId, date: { gte: firstDayOfMonth } },
      _sum: { views: true, earnings: true }
    });

    const payouts = await prisma.payoutRequest.findMany({ where: { adminId } });
    let totalWithdrawn = 0;
    let pendingWithdraw = 0;
    for (const p of payouts) {
      if (p.status === 'COMPLETED' || p.status === 'APPROVED') totalWithdrawn += p.amount;
      else if (p.status === 'PENDING') pendingWithdraw += p.amount;
    }

    res.json({
      total: {
        earnings: admin.totalEarnings,
        views: totalStats._sum.views || 0,
        downloads: totalStats._sum.bookmarks || 0,
        withdrawn: totalWithdrawn,
        pendingWithdraw
      },
      monthly: {
        earnings: monthlyStats._sum.earnings || 0,
        views: monthlyStats._sum.views || 0
      }
    });
  } catch (error: any) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports', details: error?.message || String(error) });
  }
});

export default router;
