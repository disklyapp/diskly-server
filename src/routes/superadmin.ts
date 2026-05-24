import { Router, Request, Response } from 'express';
import prisma from '../config/prisma.js';
import { superAdminAuth } from '../middleware/auth.js';
import jwt from 'jsonwebtoken';

const router = Router();

// Login for Superadmin
router.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (
    username === process.env.SUPERADMIN_USERNAME &&
    password === process.env.SUPERADMIN_PASSWORD
  ) {
    const token = jwt.sign({ role: 'superadmin' }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '1d' });
    res.json({ token, message: 'Superadmin login successful' });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

router.use(superAdminAuth);

// Get Dashboard Data
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const totalAdmins = await prisma.admin.count();
    const totalVideos = await prisma.video.count();
    const totalEarningsResult = await prisma.admin.aggregate({
      _sum: { totalEarnings: true }
    });
    const totalEarnings = totalEarningsResult._sum.totalEarnings || 0;

    const engagements = await prisma.video.aggregate({
      _sum: { views: true, likes: true, bookmarks: true }
    });

    res.json({
      totalAdmins,
      totalVideos,
      totalEarnings,
      engagements: {
        views: engagements._sum.views || 0,
        likes: engagements._sum.likes || 0,
        bookmarks: engagements._sum.bookmarks || 0,
      }
    });
  } catch (error: any) {
    console.error('Error fetching superadmin dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch superadmin dashboard data', details: error?.message || String(error) });
  }
});

// Get Settings
router.get('/settings', async (req: Request, res: Response) => {
  try {
    let setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
    if (!setting) {
      setting = await prisma.systemSetting.create({ data: {} });
    }
    res.json(setting);
  } catch (error: any) {
    console.error('Error fetching system settings:', error);
    res.status(500).json({ error: 'Failed to fetch system settings', details: error?.message || String(error) });
  }
});

// Update Settings
router.put('/settings', async (req: Request, res: Response) => {
  const { earningRatePer1000Views, telegramUploadEnabled, minimumPayoutThreshold } = req.body;
  try {
    const setting = await prisma.systemSetting.upsert({
      where: { id: 1 },
      update: { earningRatePer1000Views, telegramUploadEnabled, minimumPayoutThreshold },
      create: { earningRatePer1000Views, telegramUploadEnabled, minimumPayoutThreshold }
    });
    res.json(setting);
  } catch (error: any) {
    console.error('Error updating system settings:', error);
    res.status(500).json({ error: 'Failed to update system settings', details: error?.message || String(error) });
  }
});

// Get All Admins
router.get('/admins', async (req: Request, res: Response) => {
  try {
    const admins = await prisma.admin.findMany({
      select: { id: true, email: true, telegramUploadId: true, dailyUploadLimit: true, monthlyUploadLimit: true, balance: true, totalEarnings: true, isActive: true, createdAt: true }
    });
    res.json(admins);
  } catch (error: any) {
    console.error('Error fetching admins:', error);
    res.status(500).json({ error: 'Failed to fetch admins list', details: error?.message || String(error) });
  }
});

// Update admin status (cancel / activate)
router.put('/admins/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { isActive } = req.body;
  
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'isActive must be a boolean' });
  }

  try {
    const updated = await prisma.admin.update({
      where: { id: Number(id) },
      data: { isActive },
      select: { id: true, email: true, isActive: true }
    });
    res.json({ message: `Admin account ${isActive ? 'activated' : 'deactivated'} successfully`, admin: updated });
  } catch (error: any) {
    console.error('Error updating admin status:', error);
    res.status(500).json({ error: 'Failed to update admin status', details: error?.message || String(error) });
  }
});

// Update limits for specific admin or bulk update (if body is array)
router.put('/admins/limits', async (req: Request, res: Response) => {
  const { adminIds, dailyUploadLimit, monthlyUploadLimit } = req.body;
  if (!Array.isArray(adminIds)) return res.status(400).json({ error: 'adminIds must be an array' });
  
  try {
    const updated = await prisma.admin.updateMany({
      where: { id: { in: adminIds } },
      data: { dailyUploadLimit, monthlyUploadLimit }
    });
    res.json({ message: 'Limits updated', count: updated.count });
  } catch (error: any) {
    console.error('Error updating admin limits:', error);
    res.status(500).json({ error: 'Failed to update admin limits', details: error?.message || String(error) });
  }
});

// Get Payout Requests
router.get('/payouts', async (req: Request, res: Response) => {
  try {
    const payouts = await prisma.payoutRequest.findMany({ include: { admin: { select: { email: true } } } });
    res.json(payouts);
  } catch (error: any) {
    console.error('Error fetching payout requests:', error);
    res.status(500).json({ error: 'Failed to fetch payout requests', details: error?.message || String(error) });
  }
});

// Accept or Reject Payout
router.put('/payouts/:id', async (req: Request, res: Response) => {
  const { status } = req.body; // 'ACCEPTED' or 'REJECTED'
  const { id } = req.params;

  if (status !== 'ACCEPTED' && status !== 'REJECTED') {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const payout = await prisma.payoutRequest.findUnique({ where: { id: Number(id) } });
    if (!payout) return res.status(404).json({ error: 'Payout not found' });
    if (payout.status !== 'PENDING') return res.status(400).json({ error: 'Payout is already processed' });

    if (status === 'REJECTED') {
      // Refund balance
      await prisma.$transaction([
        prisma.payoutRequest.update({ where: { id: payout.id }, data: { status } }),
        prisma.admin.update({ where: { id: payout.adminId }, data: { balance: { increment: payout.amount } } })
      ]);
    } else {
      // Just mark as accepted (balance was deducted when requested)
      await prisma.payoutRequest.update({ where: { id: payout.id }, data: { status } });
    }

    res.json({ message: `Payout ${status}` });
  } catch (error: any) {
    console.error('Error processing payout:', error);
    res.status(500).json({ error: 'Failed to process payout', details: error?.message || String(error) });
  }
});

export default router;
