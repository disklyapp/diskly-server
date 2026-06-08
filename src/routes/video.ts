import { Router, Request, Response } from 'express';
import prisma from '../config/prisma.js';

const router = Router();

// Fetch latest notifications
router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const notifications = await prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    res.json(notifications);
  } catch (error: any) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications', details: error?.message || String(error) });
  }
});

// Fetch admin profile and their published videos
router.get('/admin/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const adminIdNum = Number(id);
    if (isNaN(adminIdNum)) {
      return res.status(400).json({ error: 'Invalid admin ID' });
    }

    const admin = await prisma.admin.findUnique({
      where: { id: adminIdNum },
      select: {
        id: true,
        name: true,
        profilePic: true,
        createdAt: true,
        email: true
      }
    });

    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const videos = await prisma.video.findMany({
      where: { adminId: adminIdNum },
      select: {
        id: true,
        title: true,
        description: true,
        streamUrl: true,
        thumbnailUrl: true,
        views: true,
        likes: true,
        bookmarks: true,
        createdAt: true,
        downloadKey: true
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ admin, videos });
  } catch (error: any) {
    console.error('Error fetching admin profile:', error);
    res.status(500).json({ error: 'Failed to fetch admin profile', details: error?.message || String(error) });
  }
});

// Fetch Single Video
router.get('/:key', async (req: Request, res: Response) => {
  const { key } = req.params;
  try {
    const video = await prisma.video.findFirst({
      where: { downloadKey: key as string },
      select: { 
        title: true, streamUrl: true, thumbnailUrl: true, views: true, likes: true, bookmarks: true, createdAt: true, downloadKey: true,
        admin: { select: { id: true, name: true, email: true, profilePic: true, createdAt: true } }
      }
    });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.json(video);
  } catch (error: any) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Failed to fetch video', details: error?.message || String(error) });
  }
});

// Fetch Multiple Videos by Keys (Batch)
router.post('/batch', async (req: Request, res: Response) => {
  const { keys } = req.body;
  if (!Array.isArray(keys)) return res.status(400).json({ error: 'keys must be an array of strings' });
  
  try {
    const videos = await prisma.video.findMany({
      where: { downloadKey: { in: keys } },
      select: { 
        title: true, streamUrl: true, thumbnailUrl: true, views: true, likes: true, bookmarks: true, createdAt: true, downloadKey: true,
        admin: { select: { id: true, name: true, email: true, profilePic: true, createdAt: true } }
      }
    });
    res.json(videos);
  } catch (error: any) {
    console.error('Error fetching batch videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos', details: error?.message || String(error) });
  }
});

// Add a View (and calculate earnings)
router.post('/:key/view', async (req: Request, res: Response) => {
  const { key } = req.params;
  
  try {
    const video = await prisma.video.findFirst({ where: { downloadKey: key as string } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    let setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
    const earningPerView = (setting?.earningRatePer1000Views || 1.0) / 1000.0;

    await prisma.$transaction(async (prismaClient: any) => {
      // 1. Increment Video view
      await prismaClient.video.update({
        where: { id: video.id },
        data: { views: { increment: 1 } }
      });

      // 2. Update Admin Earnings and Balance
      await prismaClient.admin.update({
        where: { id: video.adminId },
        data: {
          balance: { increment: earningPerView },
          totalEarnings: { increment: earningPerView }
        }
      });

      // 3. Update Daily Analytic
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const analytic = await prismaClient.dailyAnalytic.findUnique({
        where: { adminId_date: { adminId: video.adminId, date: today } }
      });

      if (analytic) {
        await prismaClient.dailyAnalytic.update({
          where: { id: analytic.id },
          data: {
            views: { increment: 1 },
            earnings: { increment: earningPerView }
          }
        });
      } else {
        await prismaClient.dailyAnalytic.create({
          data: {
            adminId: video.adminId,
            date: today,
            views: 1,
            earnings: earningPerView
          }
        });
      }
    });

    res.json({ message: 'View recorded' });
  } catch (error: any) {
    console.error('Error recording view:', error);
    res.status(500).json({ error: 'Failed to record view', details: error?.message || String(error) });
  }
});

// Add a Like
router.post('/:key/like', async (req: Request, res: Response) => {
  const { key } = req.params;
  
  try {
    const video = await prisma.video.findFirst({ where: { downloadKey: key as string } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const updatedVideo = await prisma.video.update({
      where: { id: video.id },
      data: { likes: { increment: 1 } }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const analytic = await prisma.dailyAnalytic.findUnique({
      where: { adminId_date: { adminId: updatedVideo.adminId, date: today } }
    });

    if (analytic) {
      await prisma.dailyAnalytic.update({
        where: { id: analytic.id },
        data: { likes: { increment: 1 } }
      });
    }

    res.json({ message: 'Like recorded' });
  } catch (error: any) {
    console.error('Error recording like:', error);
    res.status(500).json({ error: 'Failed to record like', details: error?.message || String(error) });
  }
});

// Add a Download (Bookmark)
router.post('/:key/download', async (req: Request, res: Response) => {
  const { key } = req.params;
  
  try {
    const video = await prisma.video.findFirst({ where: { downloadKey: key as string } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    await prisma.video.update({
      where: { id: video.id },
      data: { bookmarks: { increment: 1 } }
    });

    res.json({ message: 'Download recorded' });
  } catch (error: any) {
    console.error('Error recording download:', error);
    res.status(500).json({ error: 'Failed to record download', details: error?.message || String(error) });
  }
});

export default router;
