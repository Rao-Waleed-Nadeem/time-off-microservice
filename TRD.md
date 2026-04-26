# Technical Requirements Document (TRD)

## Time-Off Microservice — ExampleHR

**Version:** 1.0.0  
**Author:** Waleed  
**Date:** 2025  
**Status:** Final

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [System Architecture](#3-system-architecture)
4. [Key Challenges & Solutions](#4-key-challenges--solutions)
5. [Data Model](#5-data-model)
6. [API Specification](#6-api-specification)
7. [HCM Integration Layer](#7-hcm-integration-layer)
8. [Balance Integrity & Sync Strategy](#8-balance-integrity--sync-strategy)
9. [Error Handling & Defensive Programming](#9-error-handling--defensive-programming)
10. [Alternatives Considered](#10-alternatives-considered)
11. [Security Considerations](#11-security-considerations)
12. [Testing Strategy](#12-testing-strategy)
13. [Deployment & Configuration](#13-deployment--configuration)

---

## 1. Overview

ExampleHR requires a **Time-Off Microservice** that acts as the orchestration layer between employees requesting time off and the authoritative HCM system (e.g., Workday, SAP SuccessFactors). The microservice owns the lifecycle of time-off requests and maintains a locally-cached, always-consistent view of balances — while treating the HCM as the Source of Truth.

### Core Responsibilities

- Manage the full lifecycle of a time-off request: `PENDING → APPROVED | REJECTED | CANCELLED`
- Maintain a local balance cache (per-employee, per-location) that stays in sync with HCM
- Handle HCM-initiated balance updates (work anniversary bonus, yearly refresh) via both real-time and batch mechanisms
- Provide fast, reliable read endpoints for employees and managers
- Be defensively programmed: never trust HCM to always catch violations; validate locally first

---

## 2. Goals & Non-Goals

### Goals

- Expose REST endpoints for time-off request CRUD operations
- Expose REST endpoints for balance reads and manual sync triggers
- Ingest HCM batch balance updates (full corpus sync)
- Integrate with HCM real-time API for per-employee/location balance reads and writes
- Guarantee balance integrity even when multiple requests are submitted concurrently
- Detect and reconcile balance drift between local cache and HCM
- Idempotent sync operations (safe to replay batch ingestions)

### Non-Goals

- UI / frontend rendering
- Authentication/authorization (assumed handled by API Gateway upstream; stubs provided)
- Direct database access from HCM (integration is via HTTP API only)
- Managing leave types beyond what HCM exposes
- Payroll integration

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ExampleHR Platform                        │
│                                                                   │
│  ┌──────────────┐    ┌───────────────────────────────────────┐  │
│  │   Employee   │    │         Time-Off Microservice          │  │
│  │   Manager    │───▶│                                        │  │
│  │   (Client)   │    │  ┌─────────────┐  ┌────────────────┐  │  │
│  └──────────────┘    │  │  REST API   │  │  Sync Engine   │  │  │
│                       │  │  (NestJS)   │  │  (Scheduler)   │  │  │
│                       │  └──────┬──────┘  └───────┬────────┘  │  │
│                       │         │                  │            │  │
│                       │  ┌──────▼──────────────────▼────────┐  │  │
│                       │  │         Service Layer              │  │  │
│                       │  │  ┌────────────┐ ┌──────────────┐  │  │  │
│                       │  │  │  Requests  │ │   Balances   │  │  │  │
│                       │  │  │  Service   │ │   Service    │  │  │  │
│                       │  │  └────────────┘ └──────────────┘  │  │  │
│                       │  └──────────────────┬─────────────┘  │  │
│                       │                      │                  │  │
│                       │  ┌───────────────────▼──────────────┐  │  │
│                       │  │    SQLite Database (TypeORM)      │  │  │
│                       │  │  employees | balances | requests  │  │  │
│                       │  │  sync_logs | outbox               │  │  │
│                       │  └──────────────────────────────────┘  │  │
│                       └───────────────────┬───────────────────┘  │
└───────────────────────────────────────────┼─────────────────────┘
                                            │ HTTP
                            ┌───────────────▼────────────────┐
                            │         HCM System              │
                            │  (Workday / SAP / Mock Server)  │
                            │                                  │
                            │  GET  /balances/:emp/:loc        │
                            │  POST /balances/deduct           │
                            │  POST /balances/batch            │
                            └──────────────────────────────────┘
```

### Technology Stack

| Component   | Choice                                  | Rationale                                                 |
| ----------- | --------------------------------------- | --------------------------------------------------------- |
| Framework   | NestJS (Node.js)                        | Structured, DI, modular, TypeScript-first                 |
| Database    | SQLite + TypeORM                        | Lightweight, file-based, great for microservice isolation |
| HTTP Client | Axios (via NestJS HttpModule)           | Built-in retry, interceptor support                       |
| Scheduler   | `@nestjs/schedule`                      | Cron-based periodic sync jobs                             |
| Validation  | `class-validator` + `class-transformer` | Declarative, pipe-based DTO validation                    |
| Testing     | Jest + Supertest                        | Unit + integration + e2e                                  |
| Mock HCM    | Express standalone server               | Deployed separately, simulates real HCM behaviors         |

---

## 4. Key Challenges & Solutions

### Challenge 1: Concurrent Request Race Conditions

**Problem:** Two concurrent requests for the same employee/location could both read a balance of 5 days, both pass local validation, and both try to deduct — resulting in a -5 day overdraft.

**Solution: Optimistic Locking with Version Numbers**

Each `Balance` row has a `version` column. When a request is approved:

1. Read `balance WHERE employeeId = X AND locationId = Y` → `{available: 5, version: 3}`
2. Validate `available >= requestedDays`
3. `UPDATE balance SET available = available - days, version = version + 1 WHERE id = ? AND version = 3`
4. If `rowsAffected === 0`, a concurrent write happened → retry or return 409 Conflict

This guarantees exactly-once deduction without heavy serializable transactions.

### Challenge 2: HCM Balance Drift

**Problem:** HCM can update balances independently (work anniversary, year-start reset). Our local cache becomes stale without a mechanism to detect and reconcile drift.

**Solution: Periodic Reconciliation + Batch Sync Endpoint**

- Every 15 minutes (configurable), a cron job fetches balances from HCM for all active employees and compares them to local cache
- Discrepancies are logged and the local value is overwritten (HCM wins)
- HCM can also push a full batch corpus via `POST /sync/batch` — this is an idempotent upsert
- Each sync event is logged in `sync_logs` table for auditability

### Challenge 3: HCM Unreliable Error Responses

**Problem:** HCM promises to return errors for invalid requests but "this may not be always guaranteed." We cannot rely solely on HCM to prevent overdrafts.

**Solution: Local Pre-Validation**

Before calling HCM to deduct:

1. Check local balance cache: `available >= requestedDays`
2. Check no other PENDING request would exhaust the balance (compute "reserved" balance)
3. Only proceed to HCM call if local validation passes
4. If HCM returns success but our local math is inconsistent → trigger a forced reconciliation

"Reserved" balance concept:

```
effectiveAvailable = available - sum(pendingRequests.days)
```

### Challenge 4: HCM Call Failures / Network Errors

**Problem:** HCM is an external dependency. If it's down, should we reject all time-off requests?

**Solution: Outbox Pattern for Writes + Circuit Breaker**

- When a request is APPROVED, write the HCM deduction to an `outbox` table atomically with the local balance update
- A background worker processes the outbox, retrying with exponential backoff
- Reads (balance checks) use local cache with a staleness flag if last sync > threshold
- A circuit breaker prevents hammering a downed HCM

### Challenge 5: Batch Sync Idempotency

**Problem:** HCM may re-send the same batch. Double-applying it would corrupt balances.

**Solution: Idempotent Upsert with Checksum**

- Each batch record is upserted based on `(employeeId, locationId)` primary key
- Batch payloads include a `batchId` — if same `batchId` is received twice, it's a no-op
- Processed `batchId`s are stored in `sync_logs`

---

## 5. Data Model

### Entity: `Employee`

```
id          UUID     PK
externalId  string   HCM employee ID (unique)
name        string
email       string
locationId  string   FK reference (denormalized for query simplicity)
createdAt   datetime
updatedAt   datetime
```

### Entity: `Balance`

```
id          UUID     PK
employeeId  UUID     FK → Employee
locationId  string   (HCM location identifier)
leaveType   string   (e.g., "VACATION", "SICK", "PERSONAL")
available   decimal  Current available days
total       decimal  Allocated days for period
used        decimal  Days already used
version     integer  Optimistic lock counter (default: 0)
lastSyncAt  datetime Last time this was verified against HCM
createdAt   datetime
updatedAt   datetime

UNIQUE(employeeId, locationId, leaveType)
```

### Entity: `TimeOffRequest`

```
id              UUID     PK
employeeId      UUID     FK → Employee
locationId      string
leaveType       string
startDate       date
endDate         date
daysRequested   decimal  Calculated business days
status          enum     PENDING | APPROVED | REJECTED | CANCELLED
requestedAt     datetime
reviewedAt      datetime  (nullable)
reviewedBy      UUID      (nullable, manager ID)
rejectionReason string    (nullable)
hcmConfirmed    boolean   Has HCM acknowledged this deduction?
hcmError        string    (nullable) Error from HCM if any
createdAt       datetime
updatedAt       datetime
```

### Entity: `SyncLog`

```
id          UUID     PK
batchId     string   (nullable, for batch syncs)
syncType    enum     BATCH | REALTIME | RECONCILIATION
status      enum     SUCCESS | PARTIAL | FAILED
recordsIn   integer
recordsUpdated integer
recordsFailed  integer
errorDetails json     (nullable)
startedAt   datetime
completedAt datetime
```

### Entity: `OutboxEvent`

```
id          UUID     PK
eventType   string   e.g., "HCM_DEDUCT", "HCM_RESTORE"
payload     json
status      enum     PENDING | PROCESSING | DONE | DEAD
attempts    integer  (default: 0)
lastAttemptAt datetime (nullable)
createdAt   datetime
```

---

## 6. API Specification

### Base URL: `/api/v1`

---

#### Balances

| Method | Endpoint                                          | Description                                      |
| ------ | ------------------------------------------------- | ------------------------------------------------ |
| GET    | `/balances/:employeeId`                           | Get all balances for an employee (all locations) |
| GET    | `/balances/:employeeId/:locationId`               | Get balance for specific employee + location     |
| POST   | `/balances/sync/batch`                            | Ingest full HCM batch balance update             |
| POST   | `/balances/sync/realtime/:employeeId/:locationId` | Force real-time sync for one record              |

**GET /balances/:employeeId/:locationId — Response 200:**

```json
{
  "employeeId": "emp-123",
  "locationId": "loc-NYC",
  "leaveType": "VACATION",
  "available": 8.5,
  "total": 15.0,
  "used": 6.5,
  "effectiveAvailable": 6.5,
  "pendingDays": 2.0,
  "lastSyncAt": "2025-01-15T10:30:00Z"
}
```

**POST /balances/sync/batch — Request Body:**

```json
{
  "batchId": "batch-20250115-001",
  "records": [
    {
      "employeeId": "emp-123",
      "locationId": "loc-NYC",
      "leaveType": "VACATION",
      "available": 10.0,
      "total": 15.0,
      "used": 5.0
    }
  ]
}
```

---

#### Time-Off Requests

| Method | Endpoint                        | Description                    |
| ------ | ------------------------------- | ------------------------------ |
| POST   | `/requests`                     | Create a new time-off request  |
| GET    | `/requests/:id`                 | Get a specific request         |
| GET    | `/requests?employeeId=&status=` | List requests with filters     |
| PATCH  | `/requests/:id/approve`         | Manager approves a request     |
| PATCH  | `/requests/:id/reject`          | Manager rejects a request      |
| PATCH  | `/requests/:id/cancel`          | Employee cancels their request |

**POST /requests — Request Body:**

```json
{
  "employeeId": "emp-123",
  "locationId": "loc-NYC",
  "leaveType": "VACATION",
  "startDate": "2025-02-10",
  "endDate": "2025-02-12",
  "notes": "Family trip"
}
```

**POST /requests — Response 201:**

```json
{
  "id": "req-uuid",
  "status": "PENDING",
  "daysRequested": 3.0,
  "effectiveBalanceAfterApproval": 5.5,
  "message": "Request submitted. Awaiting manager approval."
}
```

**PATCH /requests/:id/approve — Response 200:**

```json
{
  "id": "req-uuid",
  "status": "APPROVED",
  "hcmConfirmed": true,
  "newBalance": 5.5
}
```

---

#### Health & Sync Status

| Method | Endpoint        | Description                     |
| ------ | --------------- | ------------------------------- |
| GET    | `/health`       | Service health check            |
| GET    | `/sync/status`  | Last sync run details           |
| POST   | `/sync/trigger` | Manually trigger reconciliation |

---

## 7. HCM Integration Layer

The `HcmClient` service wraps all HTTP calls to HCM with:

- **Timeout:** 5 seconds per request
- **Retry:** 3 attempts with exponential backoff (1s, 2s, 4s) for 5xx errors only
- **Circuit Breaker:** Opens after 5 consecutive failures; half-opens after 30 seconds
- **Response Validation:** All HCM responses are validated against expected schema before use

### HCM API Contract (External)

```
GET  /hcm/balances/:employeeId/:locationId/:leaveType
     → { available, total, used }

POST /hcm/balances/deduct
     Body: { employeeId, locationId, leaveType, days, requestId }
     → 200 OK | 400 Bad Request | 422 Insufficient Balance

POST /hcm/balances/restore
     Body: { employeeId, locationId, leaveType, days, requestId }
     → 200 OK

POST /hcm/balances/batch  (HCM → ExampleHR push)
     Body: { batchId, records: [...] }
     → 200 OK
```

---

## 8. Balance Integrity & Sync Strategy

### Local Validation Rules (Applied Before Any HCM Call)

1. `balance.available >= request.daysRequested` (raw balance check)
2. `(balance.available - pendingDays) >= request.daysRequested` (effective check)
3. `request.startDate >= today` (no past requests)
4. `request.endDate >= request.startDate`
5. `leaveType` is valid for the employee's location
6. Employee exists in local records

### Sync Modes

| Mode           | Trigger                                | Behavior                                                        |
| -------------- | -------------------------------------- | --------------------------------------------------------------- |
| Real-time      | Request approval or manual trigger     | Fetch single record from HCM; compare and overwrite local       |
| Batch          | HCM push or scheduled (daily midnight) | Upsert all records; log discrepancies                           |
| Reconciliation | Every 15 min cron                      | Fetch all employee balances; flag and correct drifts > 0.1 days |

### Conflict Resolution: HCM Wins

When local and HCM disagree:

- Log the discrepancy with old and new values
- Overwrite local with HCM value
- If a PENDING request's required days now exceed the reconciled balance, auto-reject the request and notify via response flag

---

## 9. Error Handling & Defensive Programming

### HTTP Error Responses

| Status | Scenario                                                |
| ------ | ------------------------------------------------------- |
| 400    | Invalid request body (validation failure)               |
| 404    | Employee, location, or request not found                |
| 409    | Concurrent modification conflict (optimistic lock miss) |
| 422    | Insufficient balance (local validation)                 |
| 423    | HCM circuit breaker open — operation deferred           |
| 500    | Internal server error                                   |
| 503    | HCM unavailable, request queued in outbox               |

### Defensive Checks Summary

- Never trust HCM alone for balance sufficiency — always validate locally first
- Treat HCM 200 responses skeptically: validate response schema before applying
- If HCM returns 200 but balance after deduction > pre-deduction balance → trigger forced reconciliation and rollback
- All financial arithmetic uses `decimal.js` to avoid floating-point drift

---

## 10. Alternatives Considered

### Alt 1: Event Sourcing for Balance State

**Approach:** Instead of storing current balance, store every debit/credit event and compute balance on-the-fly.

**Pros:** Full audit trail, perfect replay capability, no drift possible.

**Cons:** Complex query patterns, slower reads, significantly higher implementation complexity for a microservice at this scale.

**Decision:** Rejected. The balance entity with a `version` column + `sync_logs` table provides sufficient auditability without the operational overhead.

---

### Alt 2: Distributed Lock (Redis) Instead of Optimistic Locking

**Approach:** Acquire a Redis distributed lock on `(employeeId, locationId)` before any balance mutation.

**Pros:** Simpler logic, no retry needed on conflict.

**Cons:** Adds Redis as an infrastructure dependency; lock expiry edge cases; overkill for SQLite single-instance deployment.

**Decision:** Rejected in favor of optimistic locking. If the service scales to multi-instance, this can be revisited.

---

### Alt 3: Saga Pattern for Request Approval

**Approach:** Model request approval as a multi-step saga (local debit → HCM call → confirm), with compensating transactions on failure.

**Pros:** Full distributed transaction support.

**Cons:** Significant complexity; the outbox pattern achieves the same eventual consistency goal with less code.

**Decision:** Rejected. The outbox pattern is simpler and sufficient for the current consistency requirements.

---

### Alt 4: GraphQL Instead of REST

**Approach:** Expose a GraphQL API instead of REST.

**Pros:** Flexible queries, great for frontend consumption, reduces over-fetching.

**Cons:** More complex server setup; REST is more standard for microservice-to-microservice communication; HTTP caching is simpler with REST.

**Decision:** Rejected for the core API. REST is chosen for clarity and standard tooling. GraphQL can be layered on top in a future iteration.

---

### Alt 5: PostgreSQL Instead of SQLite

**Approach:** Use PostgreSQL for better concurrency, native SKIP LOCKED, and advisory locks.

**Pros:** Production-grade, better concurrency primitives, row-level locking.

**Cons:** Additional infrastructure; requirement explicitly states SQLite.

**Decision:** Rejected per requirements. The optimistic locking design is SQLite-compatible and can be migrated to PostgreSQL with minimal changes.

---

## 11. Security Considerations

- **Input Validation:** All incoming DTOs are validated via `class-validator` with strict whitelist mode (`whitelist: true, forbidNonWhitelisted: true`)
- **SQL Injection:** TypeORM with parameterized queries; no raw SQL strings
- **Rate Limiting:** `@nestjs/throttler` on request creation endpoints (10 req/min per employee)
- **Sensitive Data:** Employee IDs and balance data are never logged at INFO level — only at DEBUG, which is disabled in production
- **HCM Credentials:** Stored in environment variables, never in code or config files
- **API Authentication:** JWT middleware stub is included; plug in your Auth provider
- **CORS:** Configured to accept only known ExampleHR frontend origins

---

## 12. Testing Strategy

### Test Pyramid

```
         ┌─────────────────┐
         │   E2E Tests      │  ← Full HTTP → Service → DB → Mock HCM
         │    (~15 tests)   │
        ─┴─────────────────┴─
       ┌───────────────────────┐
       │  Integration Tests     │  ← Service layer + real SQLite + Mock HCM
       │     (~40 tests)        │
      ─┴───────────────────────┴─
    ┌─────────────────────────────┐
    │       Unit Tests             │  ← Services, validators, mappers (mocked deps)
    │       (~60 tests)            │
    └─────────────────────────────┘
```

### Key Test Scenarios

**Balance Integrity:**

- Concurrent approval of two requests exceeding total balance → only one succeeds
- Optimistic lock conflict → 409, retry succeeds
- Batch sync overwrites stale local balance
- Batch sync with duplicate batchId is a no-op

**Request Lifecycle:**

- Create → Approve → HCM confirms → balance decremented
- Create → Reject → balance unchanged
- Create → Cancel (PENDING) → balance unchanged
- Create → Approve → Cancel (APPROVED) → balance restored + HCM notified
- Request against insufficient balance → 422

**HCM Integration:**

- HCM returns 422 insufficient → request rejected even if local says OK
- HCM returns 500 → request queued in outbox, returned as "pending HCM confirmation"
- HCM circuit breaker open → graceful degradation

**Defensive Cases:**

- HCM returns 200 with obviously wrong balance → reconciliation triggered
- Batch sync with records that would cause pending requests to overdraft → auto-reject those requests

### Mock HCM Server

A standalone Express server (`mock-hcm/`) that:

- Maintains in-memory balance state
- Supports `GET /hcm/balances/:emp/:loc/:type`, `POST /hcm/balances/deduct`, `POST /hcm/balances/restore`, `POST /hcm/balances/batch`
- Exposes test-control endpoints: `POST /__test/set-balance`, `POST /__test/simulate-anniversary`, `POST /__test/set-failure-mode`
- Failure modes: `ALWAYS_500`, `ALWAYS_TIMEOUT`, `RANDOM_FAIL`, `SILENT_OVERDRAFT` (returns 200 but doesn't actually deduct)

---

## 13. Deployment & Configuration

### Environment Variables

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_PATH=./data/timeoff.db

# HCM Integration
HCM_BASE_URL=http://localhost:4000
HCM_API_KEY=your-hcm-api-key
HCM_TIMEOUT_MS=5000
HCM_RETRY_ATTEMPTS=3
HCM_CIRCUIT_BREAKER_THRESHOLD=5

# Sync Configuration
SYNC_RECONCILIATION_CRON=*/15 * * * *
SYNC_FULL_BATCH_CRON=0 0 * * *

# Rate Limiting
THROTTLE_TTL=60
THROTTLE_LIMIT=10
```

### Running the Service

```bash
# Install
npm install

# Run migrations
npm run migration:run

# Development
npm run start:dev

# Start mock HCM server (for testing)
npm run mock-hcm

# Run all tests
npm run test
npm run test:integration
npm run test:e2e
npm run test:cov
```

---

_Document ends. Code repository follows all decisions described herein._
