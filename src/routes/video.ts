import { Router, Request, Response } from 'express';
import prisma from '../config/prisma';

const router = Router();

// Add a View (and calculate earnings)
router.post('/:id/view', async (req: Request, res: Response) => {
  const { id } = req.params;
  
  try {
    const videoId = Number(id);
    const video = await prisma.video.findUnique({ where: { id: videoId } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    let setting = await prisma.systemSetting.findUnique({ where: { id: 1 } });
    const earningPerView = (setting?.earningRatePer1000Views || 1.0) / 1000.0;

    // We do this inside a transaction to ensure data consistency
    await prisma.$transaction(async (prismaClient) => {
      // 1. Increment Video view
      await prismaClient.video.update({
        where: { id: videoId },
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
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a Like
router.post('/:id/like', async (req: Request, res: Response) => {
  const { id } = req.params;
  
  try {
    const videoId = Number(id);
    const video = await prisma.video.update({
      where: { id: videoId },
      data: { likes: { increment: 1 } }
    });

    // Also update Daily Analytic
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const analytic = await prisma.dailyAnalytic.findUnique({
      where: { adminId_date: { adminId: video.adminId, date: today } }
    });

    if (analytic) {
      await prisma.dailyAnalytic.update({
        where: { id: analytic.id },
        data: { likes: { increment: 1 } }
      });
    }

    res.json({ message: 'Like recorded' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a Bookmark
router.post('/:id/bookmark', async (req: Request, res: Response) => {
  const { id } = req.params;
  
  try {
    const videoId = Number(id);
    await prisma.video.update({
      where: { id: videoId },
      data: { bookmarks: { increment: 1 } }
    });

    res.json({ message: 'Bookmark recorded' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
