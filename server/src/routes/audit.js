import { Router } from 'express';
import { ValidationError } from '../lib/errors.js';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

export function createAuditRouter(db) {
  const router = Router();

  router.get('/', requireRole('auditor', 'owner', 'admin'), (req, res) => {
    const { entityType, entityId, actorUserId, action } = req.query;
    const clauses = [];
    const params = [];

    if (entityType) {
      clauses.push('al.entity_type = ?');
      params.push(entityType);
    }
    if (entityId) {
      clauses.push('al.entity_id = ?');
      params.push(Number(entityId));
    }
    if (actorUserId) {
      clauses.push('al.actor_user_id = ?');
      params.push(Number(actorUserId));
    }
    if (action) {
      clauses.push('al.action = ?');
      params.push(action);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`
        SELECT al.*, u.username AS actor_username, u.role AS actor_role
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.actor_user_id
        ${where}
        ORDER BY al.id DESC
      `)
      .all(...params);

    res.json({
      auditLog: rows.map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        actorUsername: r.actor_username,
        actorRole: r.actor_role,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        before: r.before_json ? JSON.parse(r.before_json) : null,
        after: r.after_json ? JSON.parse(r.after_json) : null,
        reason: r.reason,
        createdAt: r.created_at,
      })),
    });
  });

  return router;
}

export function createCompanySettingsRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const settings = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
    res.json({ settings });
  });

  router.put('/', requireRole('admin'), (req, res, next) => {
    try {
      const updated = db.transaction(() => {
        const before = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
        const nextTolerance =
          req.body?.varianceToleranceBps ?? before.variance_tolerance_bps;
        if (!Number.isInteger(nextTolerance) || nextTolerance < 0) {
          throw new ValidationError('varianceToleranceBps must be a non-negative integer');
        }
        db.prepare(`
          UPDATE company_settings
          SET company_name = ?, gstin = ?, state = ?, state_code = ?,
              invoice_prefix = ?, variance_tolerance_bps = ?, updated_at = datetime('now')
          WHERE id = 1
        `).run(
          req.body?.companyName ?? before.company_name,
          req.body?.gstin ?? before.gstin,
          req.body?.state ?? before.state,
          req.body?.stateCode ?? before.state_code,
          req.body?.invoicePrefix ?? before.invoice_prefix,
          nextTolerance
        );
        const after = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'COMPANY_SETTINGS_UPDATED',
          entityType: 'company_settings',
          entityId: 1,
          before,
          after,
        });
        return after;
      })();
      return res.json({ settings: updated });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
