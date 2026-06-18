import { Router, Request, Response } from 'express';
import prisma from '../config/prisma.js';
import { superAdminAuth } from '../middleware/auth.js';
import jwt from 'jsonwebtoken';
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import fs from 'fs';
import path from 'path';

const router = Router();

// Initialize Firebase Admin SDK
const serviceAccountPath = path.resolve(process.cwd(), 'firebaseapi.json');
let firebaseInitialized = false;

try {
  let serviceAccount: any = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      console.error('Error parsing FIREBASE_SERVICE_ACCOUNT env variable:', e);
    }
  } else if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  }

  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount)
    });
    console.log('Firebase Admin initialized successfully.');
    firebaseInitialized = true;
  } else {
    console.warn('Firebase service account credentials file not found and FIREBASE_SERVICE_ACCOUNT env not set.');
  }
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
}


async function logActivity(action: string, details: string) {
  try {
    await prisma.superadminActivityLog.create({
      data: { action, details }
    });
  } catch (error) {
    console.error('Failed to log superadmin activity:', error);
  }
}

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
  const { earningRatePer1000Views, telegramUploadEnabled, minimumPayoutThreshold, defaultMaxUploadSizeWebsite, defaultMaxUploadSizeTelegram } = req.body;
  try {
    const setting = await prisma.systemSetting.upsert({
      where: { id: 1 },
      update: { earningRatePer1000Views, telegramUploadEnabled, minimumPayoutThreshold, defaultMaxUploadSizeWebsite: Number(defaultMaxUploadSizeWebsite), defaultMaxUploadSizeTelegram: Number(defaultMaxUploadSizeTelegram) },
      create: { earningRatePer1000Views, telegramUploadEnabled, minimumPayoutThreshold, defaultMaxUploadSizeWebsite: Number(defaultMaxUploadSizeWebsite), defaultMaxUploadSizeTelegram: Number(defaultMaxUploadSizeTelegram) }
    });
    await logActivity('UPDATE_SETTINGS', `Updated system settings: Earning Rate = $${earningRatePer1000Views}/1k, Telegram Bot = ${telegramUploadEnabled}, Min Payout = $${minimumPayoutThreshold}, Default Web Max = ${defaultMaxUploadSizeWebsite}MB, Default TG Max = ${defaultMaxUploadSizeTelegram}MB`);
    res.json(setting);
  } catch (error: any) {
    console.error('Error updating system settings:', error);
    res.status(500).json({ error: 'Failed to update system settings', details: error?.message || String(error) });
  }
});

// Get All Admins (with aggregated storage size and videos count)
router.get('/admins', async (req: Request, res: Response) => {
  try {
    const admins = await prisma.admin.findMany({
      include: {
        _count: {
          select: { videos: true }
        },
        videos: {
          select: { size: true }
        }
      }
    });

    const formattedAdmins = admins.map(admin => {
      const totalStorage = admin.videos.reduce((sum, v) => sum + (v.size || 0), 0);
      return {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        telegramUploadId: admin.telegramUploadId,
        dailyUploadLimit: admin.dailyUploadLimit,
        monthlyUploadLimit: admin.monthlyUploadLimit,
        maxUploadSizeWebsite: admin.maxUploadSizeWebsite,
        maxUploadSizeTelegram: admin.maxUploadSizeTelegram,
        minimumPayoutThreshold: admin.minimumPayoutThreshold,
        balance: admin.balance,
        totalEarnings: admin.totalEarnings,
        isActive: admin.isActive,
        createdAt: admin.createdAt,
        totalVideos: admin._count.videos,
        totalStorage: totalStorage
      };
    });

    res.json(formattedAdmins);
  } catch (error: any) {
    console.error('Error fetching admins:', error);
    res.status(500).json({ error: 'Failed to fetch admins list', details: error?.message || String(error) });
  }
});

// Get Single Admin details (Superadmin view)
router.get('/admins/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: Number(id) },
      include: {
        _count: {
          select: { videos: true }
        },
        videos: {
          select: { size: true }
        }
      }
    });

    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const totalStorage = admin.videos.reduce((sum, v) => sum + (v.size || 0), 0);

    res.json({
      id: admin.id,
      email: admin.email,
      name: admin.name,
      profilePic: admin.profilePic,
      bankName: admin.bankName,
      ifscCode: admin.ifscCode,
      accountNumber: admin.accountNumber,
      upiId: admin.upiId,
      telegramUploadId: admin.telegramUploadId,
      dailyUploadLimit: admin.dailyUploadLimit,
      monthlyUploadLimit: admin.monthlyUploadLimit,
      maxUploadSizeWebsite: admin.maxUploadSizeWebsite,
      maxUploadSizeTelegram: admin.maxUploadSizeTelegram,
      minimumPayoutThreshold: admin.minimumPayoutThreshold,
      balance: admin.balance,
      totalEarnings: admin.totalEarnings,
      isActive: admin.isActive,
      createdAt: admin.createdAt,
      totalVideos: admin._count.videos,
      totalStorage: totalStorage
    });
  } catch (error: any) {
    console.error('Error fetching admin details:', error);
    res.status(500).json({ error: 'Failed to fetch admin details', details: error?.message || String(error) });
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
    await logActivity('UPDATE_ADMIN_STATUS', `Updated status of admin ${updated.email} (ID: ${id}) to ${isActive ? 'ACTIVE' : 'INACTIVE'}`);
    res.json({ message: `Admin account ${isActive ? 'activated' : 'deactivated'} successfully`, admin: updated });
  } catch (error: any) {
    console.error('Error updating admin status:', error);
    res.status(500).json({ error: 'Failed to update admin status', details: error?.message || String(error) });
  }
});

// Update any field of a specific admin (including balance and nullable limits)
router.put('/admins/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { email, name, bankName, ifscCode, accountNumber, upiId, dailyUploadLimit, monthlyUploadLimit, maxUploadSizeWebsite, maxUploadSizeTelegram, minimumPayoutThreshold, balance, isActive } = req.body;
  
  try {
    const adminId = Number(id);
    const existing = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!existing) return res.status(404).json({ error: 'Admin not found' });

    const updateData: any = {};
    if (email !== undefined) updateData.email = email;
    if (name !== undefined) updateData.name = name;
    if (bankName !== undefined) updateData.bankName = bankName;
    if (ifscCode !== undefined) updateData.ifscCode = ifscCode;
    if (accountNumber !== undefined) updateData.accountNumber = accountNumber;
    if (upiId !== undefined) updateData.upiId = upiId;
    if (balance !== undefined) updateData.balance = Number(balance);
    if (isActive !== undefined) updateData.isActive = Boolean(isActive);

    // Support nullable values for limits
    if (dailyUploadLimit !== undefined) updateData.dailyUploadLimit = dailyUploadLimit === null ? null : Number(dailyUploadLimit);
    if (monthlyUploadLimit !== undefined) updateData.monthlyUploadLimit = monthlyUploadLimit === null ? null : Number(monthlyUploadLimit);
    if (maxUploadSizeWebsite !== undefined) updateData.maxUploadSizeWebsite = maxUploadSizeWebsite === null ? null : Number(maxUploadSizeWebsite);
    if (maxUploadSizeTelegram !== undefined) updateData.maxUploadSizeTelegram = maxUploadSizeTelegram === null ? null : Number(maxUploadSizeTelegram);
    if (minimumPayoutThreshold !== undefined) updateData.minimumPayoutThreshold = minimumPayoutThreshold === null ? null : Number(minimumPayoutThreshold);

    const updated = await prisma.admin.update({
      where: { id: adminId },
      data: updateData
    });

    await logActivity('EDIT_ADMIN', `Superadmin updated details of admin ${existing.email} (ID: ${id}). Changes: ${JSON.stringify(updateData)}`);
    res.json(updated);
  } catch (error: any) {
    console.error('Error updating admin details:', error);
    res.status(500).json({ error: 'Failed to update admin details', details: error?.message || String(error) });
  }
});

// Send payment to specific admin (increments balance and totalEarnings)
router.post('/admins/:id/pay', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { amount, remarks } = req.body;
  
  if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  try {
    const adminId = Number(id);
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const updated = await prisma.admin.update({
      where: { id: adminId },
      data: {
        balance: { increment: Number(amount) },
        totalEarnings: { increment: Number(amount) }
      }
    });

    await logActivity('SEND_PAYMENT', `Superadmin sent payment of $${amount} to admin ${admin.email}. Remarks: ${remarks || 'None'}`);
    res.json({ message: 'Payment sent successfully', admin: updated });
  } catch (error: any) {
    console.error('Error sending payment:', error);
    res.status(500).json({ error: 'Failed to send payment', details: error?.message || String(error) });
  }
});

// Update limits for specific admin or bulk update (supporting null values for unlimited status)
router.put('/admins/limits', async (req: Request, res: Response) => {
  const { adminIds, dailyUploadLimit, monthlyUploadLimit, maxUploadSizeWebsite, maxUploadSizeTelegram } = req.body;
  if (!Array.isArray(adminIds)) return res.status(400).json({ error: 'adminIds must be an array' });
  
  try {
    const data: any = {};
    if (dailyUploadLimit !== undefined) data.dailyUploadLimit = dailyUploadLimit === null ? null : Number(dailyUploadLimit);
    if (monthlyUploadLimit !== undefined) data.monthlyUploadLimit = monthlyUploadLimit === null ? null : Number(monthlyUploadLimit);
    if (maxUploadSizeWebsite !== undefined) data.maxUploadSizeWebsite = maxUploadSizeWebsite === null ? null : Number(maxUploadSizeWebsite);
    if (maxUploadSizeTelegram !== undefined) data.maxUploadSizeTelegram = maxUploadSizeTelegram === null ? null : Number(maxUploadSizeTelegram);

    const updated = await prisma.admin.updateMany({
      where: { id: { in: adminIds } },
      data
    });
    await logActivity('UPDATE_LIMITS_BULK', `Updated limits for admin IDs [${adminIds.join(', ')}]. Changes: ${JSON.stringify(data)}`);
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

// Delete Video globally
router.delete('/videos/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const videoId = Number(id);
    const video = await prisma.video.findUnique({ where: { id: videoId } });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    await prisma.video.delete({ where: { id: videoId } });
    await logActivity('DELETE_VIDEO', `Superadmin deleted video "${video.title}" (ID: ${id}) globally.`);
    res.json({ message: 'Video deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video', details: error?.message || String(error) });
  }
});

// Get Payout Requests
router.get('/payouts', async (req: Request, res: Response) => {
  try {
    const payouts = await prisma.payoutRequest.findMany({
      include: {
        admin: {
          select: {
            email: true,
            name: true,
            bankName: true,
            ifscCode: true,
            accountNumber: true,
            upiId: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    res.json(payouts);
  } catch (error: any) {
    console.error('Error fetching payout requests:', error);
    res.status(500).json({ error: 'Failed to fetch payout requests', details: error?.message || String(error) });
  }
});

// Update or Process Payout Request
router.put('/payouts/:id', async (req: Request, res: Response) => {
  const { status, remarks, transactionId } = req.body;
  const { id } = req.params;

  try {
    const payoutId = Number(id);
    const payout = await prisma.payoutRequest.findUnique({ where: { id: payoutId } });
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    const updateData: any = {};
    if (remarks !== undefined) updateData.remarks = remarks;
    if (transactionId !== undefined) updateData.transactionId = transactionId;

    if (status !== undefined && status !== payout.status) {
      if (payout.status !== 'PENDING' && payout.status !== 'APPROVED' && payout.status !== 'IN_REVIEW') {
        return res.status(400).json({ error: 'Payout status has already been finalized' });
      }

      updateData.status = status;

      if (status === 'REJECTED' || status === 'CANCELLED') {
        // Refund balance
        await prisma.$transaction([
          prisma.payoutRequest.update({ where: { id: payoutId }, data: updateData }),
          prisma.admin.update({ where: { id: payout.adminId }, data: { balance: { increment: payout.amount } } })
        ]);
      } else {
        await prisma.payoutRequest.update({ where: { id: payoutId }, data: updateData });
      }
    } else {
      await prisma.payoutRequest.update({ where: { id: payoutId }, data: updateData });
    }

    await logActivity('PROCESS_PAYOUT', `Superadmin processed payout #${id}. Status: ${status || payout.status}, Remarks: ${remarks || ''}, TxID: ${transactionId || ''}`);
    res.json({ message: `Payout updated successfully` });
  } catch (error: any) {
    console.error('Error processing payout:', error);
    res.status(500).json({ error: 'Failed to process payout', details: error?.message || String(error) });
  }
});

// Get Activity Logs
router.get('/activity-logs', async (req: Request, res: Response) => {
  try {
    const logs = await prisma.superadminActivityLog.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(logs);
  } catch (error: any) {
    console.error('Error fetching activity logs:', error);
    res.status(500).json({ error: 'Failed to fetch activity logs', details: error?.message || String(error) });
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

    // Send push notification via Firebase Cloud Messaging if initialized
    if (firebaseInitialized) {
      try {
        const payload = {
          notification: {
            title: title,
            body: message
          },
          topic: 'all_users'
        };
        await getMessaging().send(payload);
        console.log(`Successfully sent push notification for: "${title}" to topic "all_users"`);
      } catch (fcmError) {
        console.error('FCM Error sending push notification:', fcmError);
      }
    } else {
      console.warn('FCM Push notification skipped: Firebase Admin SDK is not initialized.');
    }

    res.json({ message: 'Notification sent successfully', notification });
  } catch (error: any) {
    console.error('Error creating notification:', error);
    res.status(500).json({ error: 'Failed to send notification', details: error?.message || String(error) });
  }
});

export default router;
