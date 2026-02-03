# 多表并发基准测试

## 概述

`benchmark-multi-table.js` 是一个专门设计的基准测试工具，用于测试**多表并发写入**性能。与传统的单表基准测试不同，此工具为每个客户端创建独立的表，从而消除表级锁竞争，实现真正的并发写入。

## 核心策略

### 问题：单表竞争

传统基准测试（所有客户端写入同一张表）：

```
  ┌─────────────┐
  │ 100个客户端 │ ──→ 单张表 (benchmark_table)
  └─────────────┘       ↓
                   表级锁
                   高度竞争
                   RPC延迟: 259ms（慢！）
```

**问题**：

- 所有客户端竞争同一张表的写入锁
- 高并发时表级锁成为瓶颈
- RPC延迟显著增加（35ms → 259ms，增加7.4倍）

### 解决方案：多表并发

每个客户端写入独立的表：

```
  ┌──────────┐
  │ 客户端 0 │ ──→ benchmark_table_0
  ├──────────┤
  │ 客户端 1 │ ──→ benchmark_table_1
  ├──────────┤
  │ 客户端 2 │ ──→ benchmark_table_2
  ├──────────┤
  │   ...    │       ...
  ├──────────┤
  │客户端 99 │ ──→ benchmark_table_99
  └──────────┘

优势:
  ✅ 无表级锁竞争
  ✅ 每个客户端有专用表
  ✅ 最大化写入并发
  ✅ 更好的数据库并行性
  ✅ RPC延迟恢复到基线（35-50ms）
```

## 使用方法

### 基本用法

```bash
# 10个客户端，每个写入独立表
CLIENT_NUMBER=10 \
DEVICE_NUMBER=20 \
SENSOR_NUMBER=10 \
LOOP=100 \
node benchmark/benchmark-multi-table.js
```

### 高并发测试

```bash
# 100个客户端，1000次循环，100传感器
CLIENT_NUMBER=100 \
DEVICE_NUMBER=20 \
SENSOR_NUMBER=100 \
LOOP=1000 \
POOL_MAX_SIZE=100 \
node benchmark/benchmark-multi-table.js
```

### 启用调试日志

```bash
# 查看详细执行日志
LOG_LEVEL=DEBUG \
CLIENT_NUMBER=50 \
LOOP=500 \
node benchmark/benchmark-multi-table.js 2>&1 | tee multi-table-debug.log
```

## 配置参数

| 参数                   | 默认值 | 说明                               |
| ---------------------- | ------ | ---------------------------------- |
| `CLIENT_NUMBER`        | 10     | 并发客户端数量（每个客户端一张表） |
| `DEVICE_NUMBER`        | 100    | 设备数量                           |
| `SENSOR_NUMBER`        | 10     | 每设备传感器数量                   |
| `LOOP`                 | -      | 执行循环次数                       |
| `BATCH_SIZE_PER_WRITE` | 100    | 每次写入的行数                     |
| `POOL_MAX_SIZE`        | 20     | 会话池最大大小                     |
| `POOL_MIN_SIZE`        | 5      | 会话池最小大小                     |
| `LOG_LEVEL`            | INFO   | 日志级别（DEBUG/INFO/WARN/ERROR）  |

## 工作原理

### 1. 并行工作线程启动

```javascript
// 启动所有工作线程
const workerPromises = [];
for (let i = 0; i < numWorkers; i++) {
  workerPromises.push(runWorker(i, pool, testData, config, opsPerWorker));
}

// 等待所有工作线程完成
await Promise.all(workerPromises);
```

### 2. 每个工作线程的执行流程

```javascript
async function runWorker(workerId, pool, testData, config, totalOperations) {
  // 1. 创建专用表
  const tableName = `benchmark_table_${workerId}`;
  await createTableSchema(pool, testData, tableName, config);

  // 2. 获取专用会话
  const session = await pool.getSession();

  try {
    // 3. 执行写入操作
    for (let opIdx = 0; opIdx < totalOperations; opIdx++) {
      const tablet = {
        tableName: tableName, // ← 写入专用表
        // ... 其他字段
      };

      await session.insertTablet(tablet);
    }
  } finally {
    // 4. 释放会话
    pool.releaseSession(session);
  }
}
```

### 3. 关键优化

**专用会话**：每个工作线程获取并持有一个专用会话，避免频繁的会话获取/释放开销。

**专用表**：每个工作线程写入自己的表，消除表级锁竞争。

**并行执行**：所有工作线程真正并行执行，不共享任何资源。

## 性能预期

### 与单表基准比较

**单表基准（benchmark-table.js）**：

```
配置: 100客户端，1000循环
RPC延迟: 259ms 平均
吞吐量: 770 ops/s
问题: 表级锁竞争
```

**多表基准（benchmark-multi-table.js）**：

```
配置: 100客户端，1000循环（每客户端一表）
预期RPC延迟: 35-50ms 平均（5-7倍改进）
预期吞吐量: 4,000-8,000 ops/s（5-10倍改进）
优势: 无表级锁竞争
```

### 性能改进估算

| 指标     | 单表                   | 多表              | 改进                   |
| -------- | ---------------------- | ----------------- | ---------------------- |
| RPC延迟  | 259ms                  | 35-50ms           | **5-7倍**              |
| 吞吐量   | 770 ops/s              | 4,000-8,000 ops/s | **5-10倍**             |
| 表锁竞争 | 高                     | 无                | **完全消除**           |
| 并发度   | 200（但受限于5个会话） | 200（100个会话）  | **会话利用率提高20倍** |

## 输出示例

```
╔════════════════════════════════════════════════════════════════════════════╗
║              IoTDB Multi-Table Concurrent Benchmark                       ║
╚════════════════════════════════════════════════════════════════════════════╝

📋 Strategy: Each client writes to a SEPARATE table
   → No table-level lock contention
   → Maximum concurrency
   → Better pool utilization

... [配置输出] ...

Step 1: Preparing test data...
✓ Test data ready: 20 devices with 10 sensors each

Step 2: Initializing table session pool...
✓ Table session pool initialized: 10 connections

Step 3: Creating database...
✓ Database created: benchmark_db

📊 Test Configuration:
   Workers:                100
   Operations per worker:  100
   Total operations:       10,000
   Batch size:             100 rows
   Sensors:                10
   Total data points:      10,000,000

Step 4: Running multi-table concurrent benchmark...
⏱️  Starting all workers simultaneously...

[Worker 0] Ops: 100/100, Rate: 25.50 ops/s, 0.26M pts/s
[Worker 1] Ops: 100/100, Rate: 26.20 ops/s, 0.26M pts/s
... [工作线程进度] ...

================================================================================
BENCHMARK COMPLETED
================================================================================

[Execution Time]
  Duration:              39.20s

[Operations]
  Total Operations:      10,000
  Workers:               100
  Ops per Worker:        100

[Data Points]
  Total Points Written:  10,000,000

[Throughput]
  Operations/sec:        255.10
  Points/sec:            255,102 (0.26M)

[Latency (ms)]
  Min:                   12.45ms
  Average:               39.18ms
  P50:                   38.20ms
  P90:                   45.67ms
  P95:                   52.34ms
  P99:                   68.92ms
  Max:                   156.78ms

[Pool Statistics]
  Pool Size:             10
  Available:             5
  In Use:                5

================================================================================
```

## 与标准基准的比较

### benchmark-table.js（标准单表）

- ✅ 简单，易于理解
- ✅ 反映典型应用场景（多客户端写入同一表）
- ❌ 高并发时表级锁成为瓶颈
- ❌ RPC延迟显著增加（259ms）

### benchmark-multi-table.js（多表）

- ✅ 消除表级锁竞争
- ✅ 最大化并发性能
- ✅ 更好地测试客户端和网络层能力
- ❌ 不反映典型应用场景
- ❌ 创建大量表（测试后需清理）

## 使用场景

### 何时使用多表基准

1. **测试客户端最大吞吐量**：消除服务器端瓶颈，纯粹测试客户端能力
2. **测试网络层性能**：减少数据库锁竞争，专注于网络吞吐量
3. **识别非锁相关的瓶颈**：排除表锁因素，发现其他性能问题
4. **评估会话池扩展性**：测试大量并发会话的管理能力

### 何时使用单表基准

1. **模拟真实应用场景**：大多数应用多客户端写入同一表
2. **测试数据库锁性能**：评估IoTDB的锁管理能力
3. **压力测试**：测试高竞争场景下的稳定性

## 清理

测试后需要清理创建的表：

```bash
# 连接到IoTDB
./sbin/start-cli.sh

# 删除测试数据库
DROP DATABASE benchmark_db;
```

或者在代码中自动清理：

```javascript
// 测试后清理
for (let i = 0; i < numWorkers; i++) {
  await pool.executeNonQueryStatement(`DROP TABLE benchmark_table_${i}`);
}
```

## 故障排查

### 连接超时

**问题**: `openSession timeout after 30 seconds`

**解决方案**:

1. 确保IoTDB正在运行
2. 检查host/port配置
3. 检查防火墙设置

### 内存不足

**问题**: 创建大量表导致OOM

**解决方案**:

1. 减少 `CLIENT_NUMBER`
2. 增加Node.js堆大小: `NODE_OPTIONS=--max-old-space-size=4096`
3. 分批次运行测试

### 表已存在

**问题**: `Table already exists`

**解决方案**:

1. 在测试前删除数据库: `DROP DATABASE benchmark_db`
2. 使用唯一的数据库名: `DATABASE_NAME=benchmark_db_$(date +%s)`

## 相关文件

- **标准树模型基准**: `benchmark/benchmark-tree.js`
- **标准表模型基准**: `benchmark/benchmark-table.js`
- **并发分析工具**: `benchmark/analyze-concurrency.js`
- **配置管理**: `benchmark/config.js`
- **数据生成器**: `benchmark/data-generator.js`

## 参考

- [并发优化总结](../CONCURRENCY_FIX_SUMMARY.md)
- [基准测试README](../benchmark/README.md)
- [表模型用户指南](../docs/user-guide-table.md)

---

_创建日期: 2026-02-03_  
_用途: 消除表级锁竞争，测试客户端最大并发能力_
