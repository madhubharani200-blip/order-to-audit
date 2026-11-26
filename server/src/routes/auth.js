import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

export function createAuthRouter(db, jwtSecret) {
  const router = Router();

  router.post('/login', (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (!username || !password) {
        throw new ValidationError('username and password are required');
      }

      const user = db
        .prepare('SELECT id, username, full_name, role, password_hash, is_active FROM users WHERE username = ?')
        .get(username);

      if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
        throw new UnauthorizedError('Invalid username or password');
      }

      const token = signToken(user, jwtSecret);
      db.transaction(() => {
        recordAudit(db, {
          actorUserId: user.id,
          action: 'USER_LOGIN',
          entityType: 'user',
          entityId: user.id,
          after: { username: user.username, role: user.role },
        });
      })();

      return res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          role: user.role,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/me', authenticate(db, jwtSecret), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
