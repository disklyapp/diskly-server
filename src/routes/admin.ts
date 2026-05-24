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
import path from 'path';

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

// Register
router.post('/register', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  try {
    const existing = await prisma.admin.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already in use' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const telegramUploadId = nanoid(10);
    const admin = await prisma.admin.create({
      data: { email, password: hashedPassword, telegramUploadId }
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

// Protected routes below
router.use(adminAuth);

// Dashboard
router.get('/dashboard', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

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
      telegramUploadId: admin.telegramUploadId
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
    const analytics = await prisma.dailyAnalytic.findMany({
      where: { adminId },
      orderBy: { date: 'desc' },
      take: 30
    });
    res.json(analytics);
  } catch (error: any) {
    console.error('Error fetching admin analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics', details: error?.message || String(error) });
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
      orderBy: { createdAt: 'desc' }
    });
    res.json(videos);
  } catch (error: any) {
    console.error('Error fetching admin videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos', details: error?.message || String(error) });
  }
});

// Upload Video to Backblaze B2
router.post('/videos', upload.single('video'), async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { title, thumbnailUrl } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Video file is required. Make sure to use multipart/form-data with a "video" field.' });
  }

  if (!title) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'Title is required' });
  }

  let thumbPath = '';
  try {
    // Check limits
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) {
      fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'Admin not found' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const videosToday = await prisma.video.count({
      where: { adminId, createdAt: { gte: today } }
    });

    if (videosToday >= admin.dailyUploadLimit) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Daily upload limit reached' });
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
      data: { title, streamUrl, downloadKey, thumbnailUrl: finalThumbnailUrl, adminId }
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

export default router;
