import { Router } from 'express';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';
import { getOutstandingReport } from '../services/receivables.js';

export function createReportsRouter(db) {
  const router = Router();

  router.get('/outstanding', requireRole(...ALL_ROLES), (req, res) => {
    const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);
    const onlyWithBalance = req.query.onlyWithBalance === 'true';
    const report = getOutstandingReport(db, { asOfDate, onlyWithBalance });
    res.json(report);
  });

  return router;
}
