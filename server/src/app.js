import express from 'express';
import { errorHandler } from './lib/errors.js';
import { authenticate, DEFAULT_JWT_SECRET } from './middleware/auth.js';
import { createAuditRouter, createCompanySettingsRouter } from './routes/audit.js';
import { createAuthRouter } from './routes/auth.js';
import {
  createBomRouter,
  createCustomersRouter,
  createItemsRouter,
  createPriceListRouter,
} from './routes/masterData.js';
import { createProductionRunsRouter } from './routes/productionRuns.js';
import { createPurchasesRouter } from './routes/purchases.js';
import { createInvoicesRouter, createOrdersRouter, createPaymentsRouter } from './routes/sales.js';
import { createStockRouter } from './routes/stock.js';

export function createApp({ db, jwtSecret = process.env.JWT_SECRET || DEFAULT_JWT_SECRET }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/auth', createAuthRouter(db, jwtSecret));

  const authMiddleware = authenticate(db, jwtSecret);
  app.use('/items', authMiddleware, createItemsRouter(db));
  app.use('/customers', authMiddleware, createCustomersRouter(db));
  app.use('/boms', authMiddleware, createBomRouter(db));
  app.use('/bom', authMiddleware, createBomRouter(db));
  app.use('/price-list', authMiddleware, createPriceListRouter(db));
  app.use('/purchases', authMiddleware, createPurchasesRouter(db));
  app.use('/production-runs', authMiddleware, createProductionRunsRouter(db));
  app.use('/stock', authMiddleware, createStockRouter(db));
  app.use('/orders', authMiddleware, createOrdersRouter(db));
  app.use('/invoices', authMiddleware, createInvoicesRouter(db));
  app.use('/payments', authMiddleware, createPaymentsRouter(db));
  app.use('/audit-log', authMiddleware, createAuditRouter(db));
  app.use('/company-settings', authMiddleware, createCompanySettingsRouter(db));

  app.use(errorHandler);
  return app;
}
