#!/usr/bin/env node

/**
 * Performance comparison script: Sequential vs Parallel serialization
 * Tests with and without Worker Threads optimization
 */

const { TableSessionPool } = require('../dist/index.js');

// Test configuration
const CONFIG = {
  DEVICE_NUMBER: 100,     // 增加到 100 设备
  SENSOR_NUMBER: 100,     // 保持 100 传感器
  BATCH_SIZE: 100,        // 保持 100 行
  LOOP: 100,              // 增加到 100 次循环
  CLIENT_NUMBER: 20,      // 保持 20 并发
  POOL_MAX_SIZE: 100,
};

const IOTDB_HOST = process.env.IOTDB_HOST || '192.168.99.28';
const IOTDB_PORT = parseInt(process.env.IOTDB_PORT || '6667');
const IOTDB_USER = process.env.IOTDB_USER || 'root';
const IOTDB_PASSWORD = 'TimechoDB@2021';

console.log('='.repeat(80));
console.log('SERIALIZATION OPTIMIZATION COMPARISON TEST');
console.log('='.repeat(80));
console.log(`Configuration: ${CONFIG.DEVICE_NUMBER} devices × ${CONFIG.SENSOR_NUMBER} sensors × ${CONFIG.BATCH_SIZE} rows`);
console.log(`Total data points per operation: ${CONFIG.DEVICE_NUMBER * CONFIG.SENSOR_NUMBER * CONFIG.BATCH_SIZE}`);
console.log(`Loops: ${CONFIG.LOOP}, Concurrent clients: ${CONFIG.CLIENT_NUMBER}`);
console.log('='.repeat(80));
console.log();

/**
 * Run test with specific configuration
 */
async function runTest(testName, enableParallel) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`TEST: ${testName}`);
  console.log(`${'='.repeat(80)}`);
  
  const pool = new TableSessionPool({
    host: IOTDB_HOST,
    port: IOTDB_PORT,
    username: IOTDB_USER,
    password: IOTDB_PASSWORD,
    database: 'benchmark_db',
    maxPoolSize: CONFIG.POOL_MAX_SIZE,
    minPoolSize: 10,
    enableParallelSerialization: enableParallel,
  });

  try {
    await pool.init();
    console.log(`Pool initialized with ${CONFIG.POOL_MAX_SIZE} connections`);
    
    // Drop old table if exists to avoid schema conflicts
    try {
      await pool.executeNonQueryStatement(`DROP TABLE optimization_test_${enableParallel ? 'parallel' : 'sequential'}`);
    } catch (e) {
      // Ignore if table doesn't exist
    }
    
    // Generate test data once
    const tableName = `optimization_test_${enableParallel ? 'parallel' : 'sequential'}`;
    const testData = generateTestData(tableName);
    
    // Warmup
    console.log('Warmup phase...');
    for (let i = 0; i < 3; i++) {
      await pool.insertTablet(testData[0]);
    }
    
    // Actual test
    console.log(`Running ${CONFIG.LOOP} loops...`);
    const startTime = Date.now();
    
    // Parallel execution with multiple clients
    const workers = [];
    for (let clientId = 0; clientId < CONFIG.CLIENT_NUMBER; clientId++) {
      workers.push(runWorker(pool, testData, clientId));
    }
    
    await Promise.all(workers);
    
    const duration = (Date.now() - startTime) / 1000;
    const totalOps = CONFIG.LOOP * CONFIG.DEVICE_NUMBER;
    const totalPoints = totalOps * CONFIG.SENSOR_NUMBER * CONFIG.BATCH_SIZE;
    const opsPerSec = totalOps / duration;
    const pointsPerSec = totalPoints / duration;
    
    console.log(`\nResults:`);
    console.log(`  Duration: ${duration.toFixed(2)}s`);
    console.log(`  Total operations: ${totalOps}`);
    console.log(`  Operations/sec: ${opsPerSec.toFixed(2)}`);
    console.log(`  Points/sec: ${(pointsPerSec / 1000000).toFixed(2)}M`);
    
    return { duration, opsPerSec, pointsPerSec };
    
  } finally {
    await pool.close();
  }
}

/**
 * Worker function for concurrent execution
 */
async function runWorker(pool, testData, clientId) {
  for (let loop = 0; loop < CONFIG.LOOP; loop++) {
    const deviceIndex = loop % CONFIG.DEVICE_NUMBER;
    const tablet = testData[deviceIndex];
    
    try {
      await pool.insertTablet(tablet);
    } catch (error) {
      console.error(`Client ${clientId} error:`, error.message);
    }
  }
}

/**
 * Generate test data
 */
function generateTestData(tableName) {
  const data = [];
  
  // Generate column metadata
  const columnNames = ['device_id'];
  const columnTypes = [11]; // STRING (required for TAG columns)
  const columnCategories = [0]; // TAG
  
  for (let s = 0; s < CONFIG.SENSOR_NUMBER; s++) {
    columnNames.push(`sensor_${s}`);
    columnTypes.push(3); // FLOAT
    columnCategories.push(1); // FIELD
  }
  
  // Generate tablets for each device
  for (let d = 0; d < CONFIG.DEVICE_NUMBER; d++) {
    const timestamps = [];
    const values = [];
    
    for (let r = 0; r < CONFIG.BATCH_SIZE; r++) {
      timestamps.push(Date.now() + r * 1000);
      
      const row = [`device_${d}`];
      for (let s = 0; s < CONFIG.SENSOR_NUMBER; s++) {
        row.push(Math.random() * 100);
      }
      values.push(row);
    }
    
    data.push({
      tableName: tableName,
      columnNames,
      columnTypes,
      columnCategories,
      timestamps,
      values,
    });
  }
  
  return data;
}

/**
 * Main execution
 */
async function main() {
  try {
    // Test 1: Sequential serialization (baseline)
    const sequential = await runTest('Sequential Serialization (Baseline)', false);
    
    // Brief pause
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 2: Parallel serialization with Worker Threads
    const parallel = await runTest('Parallel Serialization (Worker Threads)', true);
    
    // Comparison
    console.log(`\n${'='.repeat(80)}`);
    console.log('PERFORMANCE COMPARISON');
    console.log('='.repeat(80));
    console.log(`Sequential: ${sequential.opsPerSec.toFixed(2)} ops/s, ${(sequential.pointsPerSec / 1000000).toFixed(2)}M pts/s`);
    console.log(`Parallel:   ${parallel.opsPerSec.toFixed(2)} ops/s, ${(parallel.pointsPerSec / 1000000).toFixed(2)}M pts/s`);
    console.log(`\nImprovement: ${((parallel.opsPerSec / sequential.opsPerSec - 1) * 100).toFixed(1)}% faster`);
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

main();
