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

3. **Pool Layer** ([src/client/BaseSessionPool.ts](../src/client/BaseSessionPool.ts), [SessionPool.ts](../src/client/SessionPool.ts), [TableSessionPool.ts](../src/client/TableSessionPool.ts))
   - Connection pooling with configurable min/max size
   - Round-robin load balancing across multiple endpoints
   - Automatic idle connection cleanup (maxIdleTime)
   - Wait queue when pool exhausted (waitTimeout)

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
- **Rationale**: Keep tsc+esbuild for library development (not Vite/Vitest - see [BUILD_INFRASTRUCTURE_ANALYSIS.md](../BUILD_INFRASTRUCTURE_ANALYSIS.md))

### Testing

```bash
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:e2e      # E2E tests (requires running IoTDB)
```

**E2E Test Pattern** (see [tests/e2e/Session.test.ts](../tests/e2e/Session.test.ts)):

- Use env vars: `IOTDB_HOST`, `IOTDB_PORT`, `IOTDB_USER`, `IOTDB_PASSWORD`
- Skip tests gracefully if no IoTDB connection: `if (!session.isOpen()) return;`
- 60-second timeout for connection: `beforeAll(..., 60000)`
- Cleanup previous runs: `try { await session.executeNonQueryStatement('DELETE DATABASE root.test') } catch {}`

### Docker for E2E Tests

```bash
# Single node (1c1d)
docker-compose -f docker-compose-1c1d.yml up -d

# Cluster (3c3d)
docker-compose -f docker-compose-3c3d.yml up -d
```

## Code Conventions

### Imports & Requires

- TypeScript files: Use `import` for own modules
- Thrift files: Use `require()` - `const ttypes = require('../thrift/generated/client_types')`

### Error Handling Pattern

```typescript
try {
  await session.executeNonQueryStatement("...");
} catch (e: any) {
  if (!e.message?.includes("already exists")) throw e; // Ignore if exists
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

### E2E Tests

- Test against real IoTDB instance (not mocks)
- Cover all data types simultaneously (see [AllDataTypes.test.ts](../tests/e2e/AllDataTypes.test.ts))
- Test pool behavior: maxPoolSize, maxIdleTime, waitTimeout
- Verify cleanup: drop databases at end to avoid pollution

## Common Pitfalls

1. **Thrift files**: Never edit `src/thrift/generated/*` - regenerate from `.thrift` files
2. **Data types**: Use official TSFile codes (0-11), not arbitrary numbers
3. **Pool constructors**: Support both old and new signature formats
4. **Session vs Pool**: Session uses first node from nodeUrls; Pool does round-robin across all
5. **Build order**: Must run `copy:thrift` after compilation to copy JS files to dist
6. **E2E timeout**: Use 60s timeout (`beforeAll(..., 60000)`) - IoTDB startup is slow

## Key Files for Reference

- [README.md](../README.md) - API documentation and examples
- [DATA_TYPES.md](../DATA_TYPES.md) - Complete data type reference (300+ lines)
- [IMPLEMENTATION.md](../IMPLEMENTATION.md) - Technical architecture details
- [PROJECT_STATUS.md](../PROJECT_STATUS.md) - Current implementation status
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Development setup and workflows

## External Dependencies

- **Apache IoTDB**: Time-series database (v1.0+)
- **Thrift**: RPC framework (v0.22.0) - uses TFramedTransport + TBinaryProtocol
- **Node.js**: v14+ (CommonJS modules)
