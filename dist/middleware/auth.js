import jwt from 'jsonwebtoken';
export const superAdminAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'supersecret');
        if (verified.role === 'superadmin') {
            return next();
        }
        else {
            res.status(403).json({ error: 'Forbidden: Superadmin access required' });
        }
    }
    catch (err) {
        res.status(400).json({ error: 'Invalid token' });
    }
};
export const adminAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Access denied' });
    }
    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'supersecret');
        req.adminId = verified.adminId;
        next();
    }
    catch (err) {
        res.status(400).json({ error: 'Invalid token' });
    }
};
