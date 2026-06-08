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

// Serve Superadmin Notification Control Panel HTML page
router.get('/notifications-panel', (req: Request, res: Response) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diskly - Superadmin Notification Control</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0D161B;
      --surface-color: #142027;
      --primary-color: #1BEBB9;
      --text-primary: #ffffff;
      --text-secondary: #8E9EAA;
      --danger-color: #ff5252;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg-color);
      color: var(--text-primary);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      background: var(--surface-color);
      border: 1px solid rgba(27, 235, 185, 0.2);
      border-radius: 20px;
      padding: 40px;
      width: 100%;
      max-width: 500px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      backdrop-filter: blur(10px);
      transition: all 0.3s ease;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 10px;
      color: var(--primary-color);
      text-align: center;
    }
    .subtitle {
      color: var(--text-secondary);
      font-size: 14px;
      text-align: center;
      margin-bottom: 30px;
    }
    .form-group {
      margin-bottom: 20px;
      display: flex;
      flex-direction: column;
    }
    label {
      font-size: 14px;
      margin-bottom: 8px;
      color: var(--text-secondary);
      font-weight: 600;
    }
    input, textarea {
      background: rgba(13, 22, 27, 0.8);
      border: 1px solid rgba(142, 158, 170, 0.3);
      padding: 14px;
      border-radius: 10px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 15px;
      transition: border-color 0.3s ease;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: var(--primary-color);
    }
    button {
      background: var(--primary-color);
      color: var(--bg-color);
      border: none;
      padding: 16px;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      width: 100%;
      margin-top: 10px;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(27, 235, 185, 0.2);
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(27, 235, 185, 0.4);
    }
    button:active {
      transform: translateY(0);
    }
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: var(--primary-color);
      color: var(--bg-color);
      padding: 12px 24px;
      border-radius: 30px;
      font-weight: 600;
      transition: transform 0.3s ease;
      box-shadow: 0 5px 15px rgba(0,0,0,0.3);
      z-index: 1000;
    }
    .toast.show {
      transform: translateX(-50%) translateY(0);
    }
    .toast.error {
      background: var(--danger-color);
      color: white;
    }
    .login-section {
      display: block;
    }
    .notification-section {
      display: none;
    }
    .logout-btn {
      background: transparent;
      border: 1px solid var(--text-secondary);
      color: var(--text-secondary);
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      margin-top: 15px;
      box-shadow: none;
    }
    .logout-btn:hover {
      background: rgba(255,82,82,0.1);
      border-color: var(--danger-color);
      color: var(--danger-color);
      box-shadow: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Diskly Panel</h1>
    <p class="subtitle" id="panel-subtitle">Superadmin Access Required</p>

    <!-- Login Area -->
    <div id="login-sec" class="login-section">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" placeholder="Enter superadmin username">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" placeholder="Enter superadmin password">
      </div>
      <button onclick="handleLogin()">Login</button>
    </div>

    <!-- Notification Form -->
    <div id="notify-sec" class="notification-section">
      <div class="form-group">
        <label for="title">Notification Title</label>
        <input type="text" id="title" placeholder="e.g. New Update Available!">
      </div>
      <div class="form-group">
        <label for="message">Message Content</label>
        <textarea id="message" rows="4" placeholder="Enter notification message details..."></textarea>
      </div>
      <button onclick="sendNotification()">Send Notification</button>
      <button class="logout-btn" onclick="handleLogout()">Logout</button>
    </div>
  </div>

  <div id="toast" class="toast">Successfully completed action!</div>

  <script>
    const API_BASE = '/api/superadmin';
    let token = localStorage.getItem('superadmin_token');

    window.onload = function() {
      if (token) {
        showNotificationForm();
      }
    };

    function showToast(msg, isError = false) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      if (isError) {
        toast.classList.add('error');
      } else {
        toast.classList.remove('error');
      }
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    }

    function showNotificationForm() {
      document.getElementById('login-sec').style.display = 'none';
      document.getElementById('notify-sec').style.display = 'block';
      document.getElementById('panel-subtitle').innerText = 'Send Push Notifications to App Users';
    }

    function showLoginForm() {
      document.getElementById('login-sec').style.display = 'block';
      document.getElementById('notify-sec').style.display = 'none';
      document.getElementById('panel-subtitle').innerText = 'Superadmin Access Required';
    }

    async function handleLogin() {
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value.trim();

      if (!username || !password) {
        showToast('Please fill all fields', true);
        return;
      }

      try {
        const res = await fetch(API_BASE + '/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
          token = data.token;
          localStorage.setItem('superadmin_token', token);
          showToast('Login successful!');
          showNotificationForm();
        } else {
          showToast(data.error || 'Login failed', true);
        }
      } catch (err) {
        showToast('Network error occurred', true);
      }
    }

    async function sendNotification() {
      const title = document.getElementById('title').value.trim();
      const message = document.getElementById('message').value.trim();

      if (!title || !message) {
        showToast('Please enter title and message', true);
        return;
      }

      try {
        const res = await fetch(API_BASE + '/notifications', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ title, message })
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403) {
          showToast('Session expired. Please login again.', true);
          handleLogout();
        } else if (res.ok) {
          showToast('Notification sent successfully!');
          document.getElementById('title').value = '';
          document.getElementById('message').value = '';
        } else {
          showToast(data.error || 'Failed to send notification', true);
        }
      } catch (err) {
        showToast('Network error occurred', true);
      }
    }

    function handleLogout() {
      localStorage.removeItem('superadmin_token');
      token = null;
      showLoginForm();
    }
  </script>
</body>
</html>`);
});

router.use(superAdminAuth);

// Get Dashboard Data
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const totalAdmins = await prisma.admin.count();
    const activeAdmins = await prisma.admin.count({ where: { isActive: true } });
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
      activeAdmins,
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

// Get Reports (Daily System Metrics)
router.get('/reports', async (req: Request, res: Response) => {
  try {
    // Group DailyAnalytics by date
    const dailyStats = await prisma.dailyAnalytic.groupBy({
      by: ['date'],
      _sum: {
        views: true,
        likes: true,
        earnings: true
      },
      orderBy: { date: 'desc' },
      take: 30 // Last 30 days
    });

    const totalVideos = await prisma.video.count();
    const totalEngagements = await prisma.video.aggregate({
      _sum: { views: true, bookmarks: true } // bookmarks act as downloads
    });

    res.json({
      dailyStats,
      totals: {
        totalVideos,
        totalViews: totalEngagements._sum.views || 0,
        totalDownloads: totalEngagements._sum.bookmarks || 0
      }
    });
  } catch (error: any) {
    console.error('Error fetching superadmin reports:', error);
    res.status(500).json({ error: 'Failed to fetch superadmin reports', details: error?.message || String(error) });
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

// Get All Videos (Superadmin view)
router.get('/videos', async (req: Request, res: Response) => {
  try {
    const videos = await prisma.video.findMany({
      include: { admin: { select: { email: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(videos);
  } catch (error: any) {
    console.error('Error fetching all videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos', details: error?.message || String(error) });
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

// Create a new notification (Superadmin only)
router.post('/notifications', async (req: Request, res: Response) => {
  const { title, message } = req.body;
  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  try {
    const notification = await prisma.notification.create({
      data: { title, message }
    });
    res.json({ message: 'Notification sent successfully', notification });
  } catch (error: any) {
    console.error('Error creating notification:', error);
    res.status(500).json({ error: 'Failed to send notification', details: error?.message || String(error) });
  }
});

export default router;
