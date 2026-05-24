import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import prisma from '../config/prisma.js';
import { adminAuth } from '../middleware/auth.js';

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

// Upload Video dummy endpoint (Usually multipart/form-data via Multer + S3/B2 logic)
router.post('/videos', async (req: Request, res: Response) => {
  const adminId = (req as any).adminId;
  const { title, streamUrl, downloadKey, thumbnailUrl } = req.body;

  try {
    // Check limits
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    // Assuming we do limit checks per day/month (a full implementation would query video count for today/this month)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const videosToday = await prisma.video.count({
      where: { adminId, createdAt: { gte: today } }
    });

    if (videosToday >= admin.dailyUploadLimit) {
      return res.status(400).json({ error: 'Daily upload limit reached' });
    }

    const video = await prisma.video.create({
      data: { title, streamUrl, downloadKey, thumbnailUrl, adminId }
    });
    
    res.json(video);
  } catch (error: any) {
    console.error('Error creating video:', error);
    res.status(500).json({ error: 'Failed to create video record', details: error?.message || String(error) });
  }
});

export default router;
