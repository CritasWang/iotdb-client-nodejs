# Apache IoTDB Node.js Client - AI Coding Agent Instructions

## Project Overview

This is a TypeScript library providing Node.js clients for Apache IoTDB time-series database. The architecture follows a layered design: **Connection** (Thrift protocol) → **Session** (single connection) → **SessionPool/TableSessionPool** (connection pooling with round-robin load balancing).

## Architecture & Key Components

### Three-Layer Design

1. **Connection Layer** ([src/connection/Connection.ts](../src/connection/Connection.ts))
   - Manages low-level Thrift connections over TCP/SSL
   - Handles session lifecycle (open/close with sessionId/statementId)
   - Single endpoint only; multi-node is handled at pool level

2. **Session Layer** ([src/client/Session.ts](../src/client/Session.ts))
   - High-level API: `executeQueryStatement()`, `executeNonQueryStatement()`, `insertTablet()`
   - Handles query result parsing and pagination (fetchSize)
   - Supports both `host/port` and `nodeUrls` config (uses first node for single session)
   - Returns **SessionDataSet** for queries - lazy loading with iterator pattern

3. **Pool Layer** ([src/client/BaseSessionPool.ts](../src/client/BaseSessionPool.ts), [SessionPool.ts](../src/client/SessionPool.ts), [TableSessionPool.ts](../src/client/TableSessionPool.ts))
   - Connection pooling with configurable min/max size
   - Round-robin load balancing across multiple endpoints
   - Automatic idle connection cleanup (maxIdleTime)
   - Wait queue when pool exhausted (waitTimeout)
   - **BaseSessionPool**: Abstract base with common pooling logic
   - **SessionPool**: Tree model (sets `sql_dialect='tree'`)
   - **TableSessionPool**: Table model (sets `sql_dialect='table'`)

### Critical Pattern: Constructor Overloading

SessionPool/TableSessionPool support two constructor signatures for backward compatibility:

```typescript
// New format (recommended):
new SessionPool({ nodeUrls: ["host1:6667", "host2:6667"], maxPoolSize: 10 });

// Old format (deprecated but supported):
new SessionPool(["host1", "host2"], 6667, { maxPoolSize: 10 });
```

When adding features, **maintain both signatures**.

### Thrift Integration

- Generated code in [src/thrift/generated/](../src/thrift/generated/) from Apache IoTDB master
- **DO NOT** modify generated files directly
- Build process copies `.js` files to `dist/thrift/generated/`
- Require statements: `require('../thrift/generated/client_types')` (not imports)
- **Why require()**: Thrift generates CommonJS, not ES modules

## Data Types - Use Official TSFile Enums

**CRITICAL**: Always use official Apache TSFile type codes (0-11), not made-up values:

| Code | Type      | JavaScript Type | Usage                             |
| ---- | --------- | --------------- | --------------------------------- |
| 0    | BOOLEAN   | boolean         | `serializeValue()` uses 1/0 bytes |
| 1    | INT32     | number          | 32-bit integer                    |
| 2    | INT64     | number/string   | Use string for values > 2^53      |
| 3    | FLOAT     | number          | Single precision                  |
| 4    | DOUBLE    | number          | Double precision                  |
| 5    | TEXT      | string          | UTF-8 string                      |
| 8    | TIMESTAMP | number/Date     | Milliseconds since epoch          |
| 9    | DATE      | number/Date     | Days since epoch (INT32)          |
| 10   | BLOB      | Buffer          | Binary data                       |
| 11   | STRING    | string          | Same as TEXT                      |

**Key Methods**: See [Session.ts](../src/client/Session.ts) `serializeColumn()` (insert) and `deserializeColumn()` (query) for serialization logic.

## Tablet Types: Tree vs Table Model

### TreeTablet (Timeseries Model)

```typescript
interface ITreeTablet {
  deviceId: string; // Full path: "root.sg.device1"
  measurements: string[]; // Sensor names: ["temp", "humidity"]
  dataTypes: number[]; // TSDataType codes
  timestamps: number[]; // Milliseconds
  values: any[][]; // [rows][columns]
}
```

- Used by `Session` and `SessionPool`
- `insertTablet()` auto-detects TreeTablet vs TableTablet by checking for `deviceId` field

### TableTablet (Relational Model)

```typescript
interface ITableTablet {
  tableName: string; // Table name (not a path)
  columnNames: string[]; // All columns
  columnTypes: number[]; // TSDataType codes
  columnCategories: ColumnCategory[]; // TAG, FIELD, ATTRIBUTE (NOT TIME)
  timestamps: number[]; // Time column handled separately
  values: any[][]; // [rows][columns]
}

enum ColumnCategory {
  TAG = 0, // Indexed for WHERE filtering
  FIELD = 1, // Measurement values
  ATTRIBUTE = 2, // Metadata not indexed
  TIME = 3, // Reserved for internal use - DO NOT USE
}
```

- Used by `TableSession` and `TableSessionPool`
- **CRITICAL**: Never include `ColumnCategory.TIME` in `columnCategories` - timestamps are separate
- `insertTablet()` auto-detects by checking for `tableName` field

## SessionDataSet Pattern (Lazy Loading)

```typescript
const dataSet = await session.executeQueryStatement("SELECT * FROM root.test");
while (await dataSet.hasNext()) {
  const row = dataSet.next();
  console.log(row.getTimestamp(), row.getValue("column_name"));
}
await dataSet.close(); // REQUIRED to free server resources
```

**Key points:**

- `hasNext()` is async - fetches next batch when needed (fetchSize rows at a time)
- `next()` is sync - returns cached RowRecord
- `toArray()` helper loads all rows into memory (only for small result sets)
- **Must call `close()`** or resources leak on server
- Pool sessions auto-released when dataset closed (cleanup callback pattern)

## Configuration Patterns

### Builder Pattern (Recommended for New Code)

```typescript
import { ConfigBuilder } from "./utils/Config";
const config = new ConfigBuilder()
  .host("localhost")
  .port(6667)
  .fetchSize(2048)
  .build();
```

### nodeUrls Support

- Accepts `string[]` format: `['host1:6667', 'host2:6668']`
- Or `EndPoint[]` format: `[{host: 'host1', port: 6667}]`
- Parse with `parseNodeUrls()` from [Config.ts](../src/utils/Config.ts)

## Development Workflows

### Build System (Two-Step Process)

```bash
npm run build  # Runs esbuild + tsc + copy:thrift
```

- **esbuild**: Fast compilation (configured in [esbuild.config.js](../esbuild.config.js))
- **tsc**: Type checking only (`--emitDeclarationOnly` for .d.ts files)
- **copy:thrift**: Copies `.js` files from `src/thrift/generated/` to `dist/thrift/generated/`
- **Rationale**: This is a Node.js library (not web app), outputs CommonJS modules
  - esbuild: Fast compilation without bundling
  - tsc: Generates proper .d.ts type declarations
  - **Do NOT migrate to Vite/Vitest** - they're optimized for web/ESM, not Node.js libraries
  - See [build-infrastructure.md](../docs/development/build-infrastructure.md) for analysis

### Testing

```bash
npm test              # All tests (runs sequentially with maxWorkers=1)
npm run test:unit     # Unit tests only
npm run test:e2e      # E2E tests (requires running IoTDB)
```

**E2E Test Pattern** (see [tests/e2e/Session.test.ts](../tests/e2e/Session.test.ts)):

```typescript
beforeAll(async () => {
  session = new Session({
    host: process.env.IOTDB_HOST || "localhost",
    port: parseInt(process.env.IOTDB_PORT || "6667"),
  });
  await session.open();
}, 60000); // 60-second timeout for connection

test("should execute query", async () => {
  if (!session.isOpen()) return; // Skip gracefully if no IoTDB

  // Cleanup previous test data
  try {
    await session.executeNonQueryStatement("DROP DATABASE root.test");
  } catch (e: any) {
    if (!e.message?.includes("not exist")) throw e;
  }

  // Test implementation...
});
```

**Critical patterns:**

- Use env vars: `IOTDB_HOST`, `IOTDB_PORT`, `IOTDB_USER`, `IOTDB_PASSWORD`
- Skip tests gracefully if no IoTDB: `if (!session.isOpen()) return;`
- 60-second timeout: `beforeAll(..., 60000)` - IoTDB startup is slow
- Cleanup previous runs: catch "already exists" or "not exist" errors
- Tests run sequentially (`maxWorkers: 1` in jest.config.js) to avoid DB conflicts

### Docker for E2E Tests

```bash
# Single node (1c1d)
docker-compose -f docker-compose-1c1d.yml up -d

# 3-node cluster (3c3d)
docker-compose -f docker-compose-3c3d.yml up -d

# Cleanup
docker-compose -f docker-compose-1c1d.yml down
```

### Performance Testing with Benchmarks

```bash
# Test benchmark infrastructure (no IoTDB required)
node benchmark/test-benchmark.js

# Run tree model benchmark
CLIENT_NUMBER=10 DEVICE_NUMBER=100 node benchmark/benchmark-tree.js

# Run table model benchmark
CLIENT_NUMBER=10 DEVICE_NUMBER=100 node benchmark/benchmark-table.js
```

**Key benchmark parameters** (see [benchmark/config.js](../benchmark/config.js)):

- `CLIENT_NUMBER`: Concurrent clients (default: 10)
- `DEVICE_NUMBER`: Number of devices (default: 100)
- `SENSOR_NUMBER`: Sensors per device (default: 10)
- `BATCH_SIZE_PER_WRITE`: Rows per write (default: 100)
- `POOL_MAX_SIZE`: Max pool connections (default: 20)

**Benchmark architecture**:

- Pre-generates data to eliminate generation overhead during testing
- Uses connection pooling for realistic high-concurrency simulation
- Reports throughput (ops/sec, points/sec) and latency percentiles (P50, P90, P95, P99)
- See [benchmark/README.md](../benchmark/README.md) for detailed documentation

## Code Conventions

### Imports & Requires

- TypeScript files: Use `import` for own modules
- Thrift files: Use `require()` - `const ttypes = require('../thrift/generated/client_types')`
- **Why**: Thrift generates CommonJS, mixing with ES imports causes issues

### Error Handling Patterns

**Ignore "already exists" errors**:

```typescript
try {
  await session.executeNonQueryStatement("CREATE DATABASE root.test");
} catch (e: any) {
  if (!e.message?.includes("already exists")) throw e;
}
```

**Cleanup with "not exist" tolerance**:

```typescript
try {
  await session.executeNonQueryStatement("DROP DATABASE root.test");
} catch (e: any) {
  if (!e.message?.includes("not exist")) throw e;
}
```

**Pool session management**:

```typescript
const session = await pool.getSession();
try {
  await session.executeNonQueryStatement('CREATE DATABASE root.demo');
  await session.insertTablet({...});
} finally {
  pool.releaseSession(session); // Always release
}
```

**SessionDataSet with cleanup**:

```typescript
const dataSet = await session.executeQueryStatement("SELECT * FROM root.test");
try {
  while (await dataSet.hasNext()) {
    const row = dataSet.next();
    // Process row
  }
} finally {
  await dataSet.close(); // Always close to free server resources
}
```

### Logging

- Use `logger` from [utils/Logger.ts](../src/utils/Logger.ts)
- Levels: `logger.debug()`, `logger.info()`, `logger.warn()`, `logger.error()`
- Set level with env var: `LOG_LEVEL=debug`

### TypeScript Settings

- Strict mode enabled in [tsconfig.json](../tsconfig.json)
- Target: ES2020, Module: CommonJS
- Prefer explicit types over `any` (ESLint warns on `@typescript-eslint/no-explicit-any`)

## Testing Guidelines

### Unit Tests

- Focus on utilities: Config parsing, Logger, data serialization
- Mock Thrift client when testing Session logic
- Example: [tests/unit/Config.test.ts](../tests/unit/Config.test.ts) tests ConfigBuilder and parseNodeUrls

### E2E Tests

- Test against real IoTDB instance (not mocks)
- Cover all data types simultaneously (see [AllDataTypes.test.ts](../tests/e2e/AllDataTypes.test.ts))
- Test pool behavior: maxPoolSize, maxIdleTime, waitTimeout
- Verify cleanup: drop databases at end to avoid pollution

**Example: Testing insertTablet with TreeTablet**:

```typescript
const tablet = {
  deviceId: "root.test.device1",
  measurements: ["temperature", "humidity"],
  dataTypes: [TSDataType.FLOAT, TSDataType.DOUBLE],
  timestamps: [Date.now(), Date.now() + 1000],
  values: [
    [25.5, 60.0],
    [26.0, 61.5],
  ],
};
await session.insertTablet(tablet);
```

**Example: Testing with TableTablet**:

```typescript
const tablet = {
  tableName: "sensor_data",
  columnNames: ["device_id", "temperature"],
  columnTypes: [TSDataType.STRING, TSDataType.FLOAT],
  columnCategories: [ColumnCategory.TAG, ColumnCategory.FIELD],
  timestamps: [Date.now()],
  values: [["device_001", 25.5]],
};
await tablePool.insertTablet(tablet);
```

## Common Pitfalls

1. **Thrift files**: Never edit `src/thrift/generated/*` - regenerate from `.thrift` files
2. **Data types**: Use official TSFile codes (0-11), not arbitrary numbers
3. **Pool constructors**: Support both old and new signature formats
4. **Session vs Pool**: Session uses first node from nodeUrls; Pool does round-robin across all
5. **Build order**: Must run `copy:thrift` after compilation to copy JS files to dist
6. **E2E timeout**: Use 60s timeout (`beforeAll(..., 60000)`) - IoTDB startup is slow
7. **SessionDataSet cleanup**: Always call `dataSet.close()` - resources leak on server otherwise
8. **ColumnCategory.TIME**: Never include in `columnCategories` - timestamps are separate field
9. **Test isolation**: Tests share database names (`root.test`), run sequentially with `maxWorkers: 1`

## Key Files for Reference

- [README.md](../README.md) - API documentation and examples
- [data-types.md](../docs/data-types.md) - Complete data type reference (300+ lines)
- [implementation.md](../docs/implementation.md) - Technical architecture details
- [project-status.md](../docs/project-status.md) - Current implementation status
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Development setup and workflows
- [sessiondataset-guide.md](../docs/sessiondataset-guide.md) - Query result handling patterns
- [tablet-interfaces.md](../docs/tablet-interfaces.md) - TreeTablet vs TableTablet guide

## External Dependencies

- **Apache IoTDB**: Time-series database (v1.0+)
- **Thrift**: RPC framework (v0.22.0) - uses TFramedTransport + TBinaryProtocol
- **Node.js**: v14+ (CommonJS modules)
