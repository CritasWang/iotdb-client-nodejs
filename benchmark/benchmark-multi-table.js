#!/usr/bin/env node
/**
 * Multi-Table Concurrent Benchmark
 * 
 * This benchmark creates MULTIPLE SEPARATE TABLES, each written by dedicated clients
 * to avoid table-level locking and maximize concurrency.
 * 
 * Key differences from standard benchmark:
 * 1. Each client group writes to a SEPARATE table
 * 2. No table-level lock contention
 * 3. True parallel write operations
 * 4. Better utilization of connection pool
 * 
 * Usage:
 *   CLIENT_NUMBER=100 DEVICE_NUMBER=20 LOOP=1000 node benchmark/benchmark-multi-table.js
 */

const { TableSessionPool } = require('../dist');
const { createConfig, printConfig } = require('./config');
const { prepareTestData } = require('./data-generator');
const { ColumnCategory } = require('../dist');
const { performance } = require('perf_hooks');

/**
 * Create table session pool
 */
function createTableSessionPool(config) {
  if (config.NODE_URLS) {
    return new TableSessionPool({
      nodeUrls: config.NODE_URLS,
      username: config.IOTDB_USER,
      password: config.IOTDB_PASSWORD,
      database: config.DATABASE_NAME,
      maxPoolSize: config.POOL_MAX_SIZE,
      minPoolSize: config.POOL_MIN_SIZE,
      maxIdleTime: config.POOL_MAX_IDLE_TIME,
      waitTimeout: config.POOL_WAIT_TIMEOUT,
    });
  } else {
    return new TableSessionPool(config.IOTDB_HOST, config.IOTDB_PORT, {
      username: config.IOTDB_USER,
      password: config.IOTDB_PASSWORD,
      database: config.DATABASE_NAME,
      maxPoolSize: config.POOL_MAX_SIZE,
      minPoolSize: config.POOL_MIN_SIZE,
      maxIdleTime: config.POOL_MAX_IDLE_TIME,
      waitTimeout: config.POOL_WAIT_TIMEOUT,
    });
  }
}

/**
 * Create schema for a single table
 */
async function createTableSchema(pool, testData, tableName, config) {
  try {
    await pool.executeNonQueryStatement(`DROP TABLE ${tableName}`);
  } catch (e) {
    // Ignore if table doesn't exist
  }

  // Build column definitions
  const columns = ['device_id STRING TAG'];
  
  for (let i = 0; i < testData.devices[0].measurements.length; i++) {
    const measurement = testData.devices[0].measurements[i];
    const dataType = testData.devices[0].dataTypes[i];
    
    const typeMap = {
      0: 'BOOLEAN',
      1: 'INT32',
      2: 'INT64',
      3: 'FLOAT',
      4: 'DOUBLE',
      5: 'TEXT',
      8: 'TIMESTAMP',
      9: 'DATE',
      10: 'BLOB',
      11: 'STRING',
    };
    
    const typeName = typeMap[dataType] || 'TEXT';
    columns.push(`${measurement} ${typeName} FIELD`);
  }
  
  const createTableSQL = `CREATE TABLE ${tableName} (${columns.join(', ')})`;
  await pool.executeNonQueryStatement(createTableSQL);
}

/**
 * Worker function - writes to a dedicated table
 */
async function runWorker(workerId, pool, testData, config, totalOperations) {
  const tableName = `benchmark_table_${workerId}`;
  const deviceId = `device_${workerId}`;
  const session = await pool.getSession();
  
  try {
    // Create dedicated table for this worker
    await createTableSchema(pool, testData, tableName, config);
    
    const metrics = {
      operations: 0,
      dataPoints: 0,
      latencies: [],
      startTime: performance.now(),
    };
    
    // Build tablet template
    const columnNames = ['device_id'];
    const columnTypes = [11]; // STRING
    const columnCategories = [ColumnCategory.TAG];
    
    // Add measurement columns
    for (let i = 0; i < testData.devices[0].measurements.length; i++) {
      columnNames.push(testData.devices[0].measurements[i]);
      columnTypes.push(testData.devices[0].dataTypes[i]);
      columnCategories.push(ColumnCategory.FIELD);
    }
    
    const batch = testData.sharedBatches[0];
    
    // Execute write operations
    for (let opIdx = 0; opIdx < totalOperations; opIdx++) {
      const startTime = performance.now();
      
      try {
        // Update timestamps to current time
        const currentTime = Date.now();
        const updatedTimestamps = batch.timestamps.map((_, idx) => 
          currentTime + idx * config.POINT_STEP
        );
        
        // Build values with device_id
        const valuesWithDeviceId = batch.values.map(row => [deviceId, ...row]);
        
        const tablet = {
          tableName: tableName,
          columnNames: columnNames,
          columnTypes: columnTypes,
          columnCategories: columnCategories,
          timestamps: updatedTimestamps,
          values: valuesWithDeviceId,
        };
        
        // Use dedicated session for this worker
        await session.insertTablet(tablet);
        
        const latency = performance.now() - startTime;
        metrics.latencies.push(latency);
        metrics.operations++;
        metrics.dataPoints += batch.timestamps.length * testData.devices[0].measurements.length;
        
      } catch (error) {
        console.error(`Worker ${workerId} error:`, error.message);
      }
      
      // Progress report every 100 operations
      if (metrics.operations % 100 === 0) {
        const elapsed = (performance.now() - metrics.startTime) / 1000;
        const opsPerSec = metrics.operations / elapsed;
        const ptsPerSec = metrics.dataPoints / elapsed;
        console.log(`[Worker ${workerId}] Ops: ${metrics.operations}/${totalOperations}, ` +
                    `Rate: ${opsPerSec.toFixed(2)} ops/s, ${(ptsPerSec/1000000).toFixed(2)}M pts/s`);
      }
    }
    
    metrics.endTime = performance.now();
    return metrics;
    
  } finally {
    pool.releaseSession(session);
  }
}

/**
 * Main function
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              IoTDB Multi-Table Concurrent Benchmark                       ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log();
  console.log('📋 Strategy: Each client writes to a SEPARATE table');
  console.log('   → No table-level lock contention');
  console.log('   → Maximum concurrency');
  console.log('   → Better pool utilization');
  console.log();

  // Create configuration
  const config = createConfig();
  printConfig(config);

  let pool = null;

  try {
    // Prepare test data
    console.log('Step 1: Preparing test data...');
    const testData = await prepareTestData(config, 'table');
    console.log(`✓ Test data ready: ${testData.devices.length} devices with ${config.SENSOR_NUMBER} sensors each`);

    // Create table session pool
    console.log('\nStep 2: Initializing table session pool...');
    pool = createTableSessionPool(config);
    await pool.init();
    console.log(`✓ Table session pool initialized: ${pool.getPoolSize()} connections`);

    // Create database
    console.log('\nStep 3: Creating database...');
    try {
      await pool.executeNonQueryStatement(`DROP DATABASE ${config.DATABASE_NAME}`);
    } catch (e) {
      // Ignore
    }
    await pool.executeNonQueryStatement(`CREATE DATABASE ${config.DATABASE_NAME}`);
    await pool.executeNonQueryStatement(`USE ${config.DATABASE_NAME}`);
    console.log(`✓ Database created: ${config.DATABASE_NAME}`);

    // Calculate operations per worker
    const numWorkers = config.CLIENT_NUMBER;
    const totalOperations = config.LOOP || Math.ceil(config.TOTAL_DATA_POINTS / 
                           (config.DEVICE_NUMBER * config.BATCH_SIZE_PER_WRITE * config.SENSOR_NUMBER));
    const opsPerWorker = Math.ceil(totalOperations / numWorkers);
    
    console.log(`\n📊 Test Configuration:`);
    console.log(`   Workers:                ${numWorkers}`);
    console.log(`   Operations per worker:  ${opsPerWorker}`);
    console.log(`   Total operations:       ${numWorkers * opsPerWorker}`);
    console.log(`   Batch size:             ${config.BATCH_SIZE_PER_WRITE} rows`);
    console.log(`   Sensors:                ${config.SENSOR_NUMBER}`);
    console.log(`   Total data points:      ${(numWorkers * opsPerWorker * config.BATCH_SIZE_PER_WRITE * config.SENSOR_NUMBER).toLocaleString()}`);

    // Run benchmark
    console.log('\nStep 4: Running multi-table concurrent benchmark...');
    console.log('⏱️  Starting all workers simultaneously...\n');
    
    const startTime = performance.now();
    
    // Launch all workers in parallel - each writes to its own table
    const workerPromises = [];
    for (let i = 0; i < numWorkers; i++) {
      workerPromises.push(runWorker(i, pool, testData, config, opsPerWorker));
    }
    
    // Wait for all workers to complete
    const allMetrics = await Promise.all(workerPromises);
    
    const endTime = performance.now();
    const totalDuration = (endTime - startTime) / 1000;
    
    // Aggregate results
    console.log('\n' + '='.repeat(80));
    console.log('BENCHMARK COMPLETED');
    console.log('='.repeat(80));
    
    const totalOps = allMetrics.reduce((sum, m) => sum + m.operations, 0);
    const totalPts = allMetrics.reduce((sum, m) => sum + m.dataPoints, 0);
    const allLatencies = allMetrics.flatMap(m => m.latencies);
    
    const avgLatency = allLatencies.reduce((sum, l) => sum + l, 0) / allLatencies.length;
    const minLatency = Math.min(...allLatencies);
    const maxLatency = Math.max(...allLatencies);
    
    // Sort for percentiles
    allLatencies.sort((a, b) => a - b);
    const p50 = allLatencies[Math.floor(allLatencies.length * 0.50)];
    const p90 = allLatencies[Math.floor(allLatencies.length * 0.90)];
    const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)];
    const p99 = allLatencies[Math.floor(allLatencies.length * 0.99)];
    
    console.log('\n[Execution Time]');
    console.log(`  Duration:              ${totalDuration.toFixed(2)}s`);
    
    console.log('\n[Operations]');
    console.log(`  Total Operations:      ${totalOps}`);
    console.log(`  Workers:               ${numWorkers}`);
    console.log(`  Ops per Worker:        ${(totalOps / numWorkers).toFixed(0)}`);
    
    console.log('\n[Data Points]');
    console.log(`  Total Points Written:  ${totalPts.toLocaleString()}`);
    
    console.log('\n[Throughput]');
    console.log(`  Operations/sec:        ${(totalOps / totalDuration).toFixed(2)}`);
    console.log(`  Points/sec:            ${(totalPts / totalDuration).toLocaleString()} (${(totalPts / totalDuration / 1000000).toFixed(2)}M)`);
    
    console.log('\n[Latency (ms)]');
    console.log(`  Min:                   ${minLatency.toFixed(2)}ms`);
    console.log(`  Average:               ${avgLatency.toFixed(2)}ms`);
    console.log(`  P50:                   ${p50.toFixed(2)}ms`);
    console.log(`  P90:                   ${p90.toFixed(2)}ms`);
    console.log(`  P95:                   ${p95.toFixed(2)}ms`);
    console.log(`  P99:                   ${p99.toFixed(2)}ms`);
    console.log(`  Max:                   ${maxLatency.toFixed(2)}ms`);
    
    console.log('\n[Pool Statistics]');
    console.log(`  Pool Size:             ${pool.getPoolSize()}`);
    console.log(`  Available:             ${pool.getAvailableSize()}`);
    console.log(`  In Use:                ${pool.getInUseSize()}`);
    
    console.log('\n' + '='.repeat(80));
    
  } catch (error) {
    console.error('\n' + '!'.repeat(80));
    console.error('BENCHMARK FAILED');
    console.error('!'.repeat(80));
    console.error('\nError:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  } finally {
    if (pool) {
      console.log('\nClosing table session pool...');
      await pool.close();
      console.log('✓ Table session pool closed');
    }
  }
}

// Run main function
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };
