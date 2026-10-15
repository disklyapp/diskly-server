import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';

export const superAdminAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Bearer token missing.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || 'supersecret', {
      algorithms: ['HS256'],
    }) as { role?: string };

    if (verified && verified.role === 'superadmin') {
      return next();
    } else {
      return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
    }
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please login again.' });
    }
    return res.status(401).json({ error: 'Invalid or forged authentication token' });
  }
};

export const adminAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. Bearer token missing.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || 'supersecret', {
      algorithms: ['HS256'],
    }) as { adminId: number };

    if (!verified || !verified.adminId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    const admin = await prisma.admin.findUnique({
      where: { id: verified.adminId },
      select: { id: true, isActive: true },
    });

    if (!admin) {
      return res.status(401).json({ error: 'Admin account not found' });
    }

    if (!admin.isActive) {
      return res.status(403).json({ error: 'Account suspended. Contact superadmin.' });
    }

    (req as any).adminId = admin.id;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please login again.' });
    }
    return res.status(401).json({ error: 'Invalid or forged authentication token' });
  }
};

