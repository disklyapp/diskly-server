import { Router, Request, Response } from 'express';
import prisma from '../config/prisma.js';
import { isViewEligible, isLikeEligible } from '../utils/fraudPrevention.js';
import {
  attachSecureUrlsToVideo,
  attachSecureUrlsToVideos,
  getSecureSignedUrl,
} from '../utils/secureStorage.js';

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

// Fetch active 1:1 featured notification for app startup popup
router.get('/featured-notification', async (req: Request, res: Response) => {
  try {
    const featured = await prisma.notification.findFirst({
      where: { isFeatured: true },
      orderBy: { createdAt: 'desc' }
    });
    if (featured && featured.imageUrl) {
      featured.imageUrl = await getSecureSignedUrl(featured.imageUrl, 'featured-notification.png');
    }
    res.json(featured || null);
  } catch (error: any) {
    console.error('Error fetching featured notification:', error);
    res.status(500).json({ error: 'Failed to fetch featured notification', details: error?.message || String(error) });
  }
});

// Fetch admin profile and their published videos
router.get('/admin/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    let admin = null;
    const adminIdNum = Number(id);
    if (!isNaN(adminIdNum)) {
      admin = await prisma.admin.findUnique({
        where: { id: adminIdNum },
        select: {
          id: true,
          name: true,
          profilePic: true,
          createdAt: true,
          email: true
        }
      });
    }

    if (!admin) {
      admin = await prisma.admin.findUnique({
        where: { shareId: id as string },
        select: {
          id: true,
          name: true,
          profilePic: true,
          createdAt: true,
          email: true
        }
      });
    }

    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const videos = await prisma.video.findMany({
      where: { adminId: admin.id },
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
        downloadKey: true,
        size: true,
        admin: {
          select: {
            id: true,
            name: true,
            email: true,
            profilePic: true,
            createdAt: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    const securedVideos = await attachSecureUrlsToVideos(videos);
    res.json({ admin, videos: securedVideos });
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
      include: { admin: { select: { id: true, name: true, email: true, profilePic: true, createdAt: true } } }
    });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const securedVideo = await attachSecureUrlsToVideo(video);
    res.json(securedVideo);
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
        id: true, title: true, description: true, streamUrl: true, thumbnailUrl: true, views: true, likes: true, bookmarks: true, createdAt: true, downloadKey: true, size: true,
        admin: { select: { id: true, name: true, email: true, profilePic: true, createdAt: true } }
      }
    });
    const securedVideos = await attachSecureUrlsToVideos(videos);
    res.json(securedVideos);
  } catch (error: any) {
    console.error('Error fetching batch videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos', details: error?.message || String(error) });
  }
});

// Add a View (with IP cooldown & fraud prevention to protect payout integrity)
router.post('/:key/view', async (req: Request, res: Response) => {
  const { key } = req.params;
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1';
  
  try {
    const video = await prisma.video.findFirst({ where: { downloadKey: key as string } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Fraud Prevention Check: Only 1 credited view per IP per video per 6 hours
    const isEligible = await isViewEligible(clientIp, key as string);
    if (!isEligible) {
      // Cooldown active: Return success to player so streaming is smooth, but do not increment earnings
      return res.json({ message: 'View recorded (cooldown active)', credited: false });
    }

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

    res.json({ message: 'View recorded', credited: true });
  } catch (error: any) {
    console.error('Error recording view:', error);
    res.status(500).json({ error: 'Failed to record view', details: error?.message || String(error) });
  }
});

// Add a Like (with 24h IP cooldown to prevent spam)
router.post('/:key/like', async (req: Request, res: Response) => {
  const { key } = req.params;
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1';
  
  try {
    const video = await prisma.video.findFirst({ where: { downloadKey: key as string } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const isEligible = await isLikeEligible(clientIp, key as string);
    if (!isEligible) {
      return res.json({ message: 'Like already recorded for this session', credited: false });
    }

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

    res.json({ message: 'Like recorded', credited: true });
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

// Generate Time-Limited Pre-Signed Download URL (Protects Backblaze B2 from hotlinking and bandwidth theft)
router.get('/:key/secure-download-url', async (req: Request, res: Response) => {
  const { key } = req.params;
  try {
    const video = await prisma.video.findFirst({ where: { downloadKey: key as string } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const signedUrl = await getSecureSignedUrl(
      video.streamUrl,
      `videos/${video.downloadKey}.mp4`,
      true,
      video.title
    );

    res.json({
      downloadUrl: signedUrl,
      expiresInSeconds: 21600,
      expiresAt: new Date(Date.now() + 21600 * 1000).toISOString(),
    });
  } catch (error: any) {
    console.error('Error generating secure download URL:', error);
    res.status(500).json({ error: 'Failed to generate secure download URL', details: error?.message || String(error) });
  }
});

export default router;
