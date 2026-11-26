import jwt from 'jsonwebtoken';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

export const DEFAULT_JWT_SECRET = 'dev-order-to-audit-secret-change-in-prod';

export const ALL_ROLES = ['salesman', 'admin', 'production', 'auditor', 'owner'];

export function signToken(user, secret = DEFAULT_JWT_SECRET) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      fullName: user.full_name,
    },
    secret,
    { expiresIn: '12h' }
  );
}

export function authenticate(db, secret = DEFAULT_JWT_SECRET) {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Missing or invalid Authorization header'));
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = jwt.verify(token, secret);
      const user = db
        .prepare('SELECT id, username, full_name, role, is_active FROM users WHERE id = ?')
        .get(payload.sub);
      if (!user || !user.is_active) {
        return next(new UnauthorizedError('User account inactive or not found'));
      }
      req.user = {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
      };
      return next();
    } catch {
      return next(new UnauthorizedError('Invalid or expired token'));
    }
  };
}

export function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }
    if (req.user.role === 'auditor' && req.method !== 'GET' && req.method !== 'HEAD') {
      return next(new ForbiddenError('Auditor role is read-only'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new ForbiddenError(
          `Role '${req.user.role}' is not permitted for ${req.method} ${req.baseUrl}${req.path}`
        )
      );
    }
    return next();
  };
}
