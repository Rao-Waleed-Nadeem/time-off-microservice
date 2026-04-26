/**
 * Mock HCM Server
 *
 * Simulates a real HCM system (Workday/SAP) for local development and testing.
 * Supports:
 *  - Balance reads per employee/location/leaveType
 *  - Balance deductions and restorations
 *  - Batch balance pushes
 *  - Work anniversary simulation (balance bonus)
 *  - Configurable failure modes for testing defensive logic
 */

import express, { Request, Response, NextFunction } from 'express';

const app = express();
app.use(express.json());

// ── In-memory state ──────────────────────────────────────────────────────────

interface BalanceRecord {
  employeeId: string;
  locationId: string;
  leaveType: string;
  available: number;
  total: number;
  used: number;
}

// key: `${employeeId}:${locationId}:${leaveType}`
const balances = new Map<string, BalanceRecord>();
const processedBatchIds = new Set<string>();
const processedDeductions = new Map<string, number>(); // requestId → days deducted (idempotency)

type FailureMode =
  | 'NONE'
  | 'ALWAYS_500'
  | 'ALWAYS_TIMEOUT'
  | 'RANDOM_FAIL'
  | 'SILENT_OVERDRAFT'
  | 'ALWAYS_422';
let failureMode: FailureMode = 'NONE';
let failureRatePercent = 30; // used for RANDOM_FAIL

const PORT = process.env.MOCK_HCM_PORT || 4000;

function balanceKey(emp: string, loc: string, lt: string): string {
  return `${emp}:${loc}:${lt}`;
}

// ── Middleware: failure injection ────────────────────────────────────────────

function failureMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip test-control endpoints
  if (req.path.startsWith('/__test')) return next();

  if (failureMode === 'ALWAYS_500') {
    return res
      .status(500)
      .json({ error: 'HCM Internal Server Error (simulated)' });
  }

  if (failureMode === 'ALWAYS_TIMEOUT') {
    // Never respond — let the client time out
    return;
  }

  if (failureMode === 'ALWAYS_422') {
    return res
      .status(422)
      .json({ error: 'Insufficient balance (simulated by failure mode)' });
  }

  if (failureMode === 'RANDOM_FAIL') {
    if (Math.random() * 100 < failureRatePercent) {
      return res.status(500).json({ error: 'Random HCM failure (simulated)' });
    }
  }

  next();
}

app.use(failureMiddleware);

// ── HCM API Endpoints ────────────────────────────────────────────────────────

/**
 * GET /hcm/balances/:employeeId/:locationId/:leaveType
 */
app.get('/hcm/balances/:employeeId/:locationId/:leaveType', (req, res) => {
  const { employeeId, locationId, leaveType } = req.params;
  const key = balanceKey(employeeId, locationId, leaveType);
  console.log(
    `[HCM GET] Looking up key: ${key}, known keys:`,
    Array.from(balances.keys()),
  );
  const balance = balances.get(key);

  if (!balance) {
    return res.status(404).json({
      error: 'Balance not found',
      message: `No balance record for employee ${employeeId} at location ${locationId} with leave type ${leaveType}`,
    });
  }

  res.json(balance);
});

/**
 * POST /hcm/balances/deduct
 * Body: { employeeId, locationId, leaveType, days, requestId }
 */
app.post('/hcm/balances/deduct', (req, res) => {
  const { employeeId, locationId, leaveType, days, requestId } = req.body;

  if (!employeeId || !locationId || !leaveType || days == null || !requestId) {
    return res.status(400).json({
      error:
        'Missing required fields: employeeId, locationId, leaveType, days, requestId',
    });
  }

  if (days <= 0) {
    return res.status(400).json({ error: 'days must be positive' });
  }

  // Idempotency: if same requestId was already processed, return success
  if (processedDeductions.has(requestId)) {
    return res.json({
      success: true,
      message: 'Already processed (idempotent)',
      idempotent: true,
    });
  }

  const key = balanceKey(employeeId, locationId, leaveType);
  const balance = balances.get(key);

  if (!balance) {
    return res.status(404).json({ error: 'Balance record not found in HCM' });
  }

  if (failureMode === 'SILENT_OVERDRAFT') {
    // Bug simulation: return 200 but don't actually deduct
    console.log(
      `[SILENT_OVERDRAFT] Pretending to deduct ${days} from ${employeeId} but not doing it`,
    );
    processedDeductions.set(requestId, days);
    return res.json({
      success: true,
      newAvailable: balance.available,
      silent: true,
    });
  }

  if (balance.available < days) {
    return res.status(422).json({
      error: 'Insufficient balance',
      message: `Cannot deduct ${days} days: only ${balance.available} available for ${leaveType}`,
      available: balance.available,
      requested: days,
    });
  }

  balance.available = parseFloat((balance.available - days).toFixed(4));
  balance.used = parseFloat((balance.used + days).toFixed(4));
  processedDeductions.set(requestId, days);

  console.log(
    `[HCM] Deducted ${days} days from ${employeeId}/${locationId}/${leaveType} → available: ${balance.available}`,
  );

  res.json({
    success: true,
    employeeId,
    locationId,
    leaveType,
    deducted: days,
    newAvailable: balance.available,
    newUsed: balance.used,
  });
});

/**
 * POST /hcm/balances/restore
 * Body: { employeeId, locationId, leaveType, days, requestId }
 */
app.post('/hcm/balances/restore', (req, res) => {
  const { employeeId, locationId, leaveType, days, requestId } = req.body;

  if (!employeeId || !locationId || !leaveType || days == null) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const key = balanceKey(employeeId, locationId, leaveType);
  const balance = balances.get(key);

  if (!balance) {
    return res.status(404).json({ error: 'Balance record not found in HCM' });
  }

  balance.available = parseFloat(
    Math.min(balance.total, balance.available + days).toFixed(4),
  );
  balance.used = parseFloat(Math.max(0, balance.used - days).toFixed(4));

  // Remove deduction idempotency record so this requestId could be processed again if needed
  processedDeductions.delete(requestId);

  console.log(
    `[HCM] Restored ${days} days for ${employeeId}/${locationId}/${leaveType} → available: ${balance.available}`,
  );

  res.json({
    success: true,
    employeeId,
    locationId,
    leaveType,
    restored: days,
    newAvailable: balance.available,
  });
});

/**
 * POST /hcm/balances/batch
 * Body: { batchId, records: [...] }
 * This simulates the HCM pushing a full batch to ExampleHR
 */
app.post('/hcm/balances/batch', (req, res) => {
  const { batchId, records } = req.body;

  if (!batchId || !Array.isArray(records)) {
    return res.status(400).json({ error: 'Missing batchId or records array' });
  }

  if (processedBatchIds.has(batchId)) {
    return res.json({
      processed: 0,
      message: 'Batch already processed (idempotent)',
    });
  }

  let processed = 0;
  for (const record of records) {
    const key = balanceKey(
      record.employeeId,
      record.locationId,
      record.leaveType,
    );
    balances.set(key, {
      employeeId: record.employeeId,
      locationId: record.locationId,
      leaveType: record.leaveType,
      available: record.available,
      total: record.total,
      used: record.used,
    });
    processed++;
  }

  processedBatchIds.add(batchId);
  console.log(`[HCM] Batch ${batchId}: processed ${processed} records`);

  res.json({ processed, batchId });
});

// ── Test Control Endpoints (not part of real HCM API) ────────────────────────

/**
 * POST /__test/set-balance
 * Seed or override a balance record in the mock
 */
app.post('/__test/set-balance', (req, res) => {
  const { employeeId, locationId, leaveType, available, total, used } =
    req.body;
  const key = balanceKey(employeeId, locationId, leaveType);
  balances.set(key, {
    employeeId,
    locationId,
    leaveType,
    available: available ?? 0,
    total: total ?? available ?? 0,
    used: used ?? 0,
  });
  console.log(`[TEST] Set balance for ${key}: available=${available}`);
  res.json({ ok: true, key, balance: balances.get(key) });
});

/**
 * GET /__test/get-balance/:employeeId/:locationId/:leaveType
 */
app.get(
  '/__test/get-balance/:employeeId/:locationId/:leaveType',
  (req, res) => {
    const { employeeId, locationId, leaveType } = req.params;
    const key = balanceKey(employeeId, locationId, leaveType);
    res.json(balances.get(key) || null);
  },
);

/**
 * POST /__test/simulate-anniversary
 * Adds bonus days to an employee's balance (simulates work anniversary)
 */
app.post('/__test/simulate-anniversary', (req, res) => {
  const { employeeId, locationId, leaveType, bonusDays } = req.body;
  const key = balanceKey(employeeId, locationId, leaveType);
  const balance = balances.get(key);
  if (!balance) {
    return res.status(404).json({ error: 'Balance not found' });
  }
  balance.available = parseFloat((balance.available + bonusDays).toFixed(4));
  balance.total = parseFloat((balance.total + bonusDays).toFixed(4));
  console.log(
    `[TEST] Anniversary bonus: +${bonusDays} for ${key} → available: ${balance.available}`,
  );
  res.json({
    ok: true,
    newAvailable: balance.available,
    newTotal: balance.total,
  });
});

/**
 * POST /__test/set-failure-mode
 * Body: { mode: 'NONE' | 'ALWAYS_500' | 'ALWAYS_TIMEOUT' | 'RANDOM_FAIL' | 'SILENT_OVERDRAFT' | 'ALWAYS_422', rate?: number }
 */
app.post('/__test/set-failure-mode', (req, res) => {
  const { mode, rate } = req.body;
  failureMode = mode;
  if (rate !== undefined) failureRatePercent = rate;
  console.log(
    `[TEST] Failure mode set to: ${mode}${rate !== undefined ? ` (rate: ${rate}%)` : ''}`,
  );
  res.json({ ok: true, mode: failureMode, rate: failureRatePercent });
});

/**
 * GET /__test/state
 * Dump all current balances and state
 */
app.get('/__test/state', (_req, res) => {
  const allBalances: BalanceRecord[] = [];
  balances.forEach((v) => allBalances.push(v));
  res.json({
    balances: allBalances,
    failureMode,
    processedBatchIds: Array.from(processedBatchIds),
    processedDeductions: Object.fromEntries(processedDeductions),
  });
});

/**
 * POST /__test/reset
 * Reset all state
 */
app.post('/__test/reset', (_req, res) => {
  balances.clear();
  processedBatchIds.clear();
  processedDeductions.clear();
  failureMode = 'NONE';
  console.log('[TEST] Mock HCM state reset');
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🏢 Mock HCM Server running on http://localhost:${PORT}`);
    console.log(`   POST /__test/set-balance        — seed balance data`);
    console.log(`   POST /__test/set-failure-mode   — inject failures`);
    console.log(`   POST /__test/simulate-anniversary — add bonus days`);
    console.log(`   GET  /__test/state              — dump current state\n`);
  });
}

export { app as mockHcmApp, balances };
