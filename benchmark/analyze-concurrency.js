/**
 * Concurrency Pattern Analyzer
 * 
 * Analyzes benchmark DEBUG logs to understand actual concurrency:
 * 1. How many operations run simultaneously?
 * 2. Are operations truly parallel or queued?
 * 3. What's the overlap between operations?
 */

const fs = require('fs');
const path = require('path');

// Parse log file name from command line or use default
const logFile = process.argv[2] || path.join(__dirname, '../benchmark-debug-20260203-table-100_1000_100POOL.log');

console.log('Analyzing concurrency patterns from:', logFile);
console.log('='.repeat(80));

try {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n');
  
  // Track active operations (in-flight requests)
  const operations = [];
  let maxConcurrency = 0;
  let totalOperations = 0;
  
  // Extract timing information
  const getSessionTimes = [];
  const insertTimes = [];
  const rpcTimes = [];
  
  // Track session pool state
  const poolStates = [];
  
  for (const line of lines) {
    // Extract timestamp from log line format: "000123.456789 [asyncId] [LEVEL] message"
    const timestampMatch = line.match(/^(\d+\.\d+)\s+\[\d+\]\s+\[(\w+)\]\s+(.+)$/);
    if (!timestampMatch) continue;
    
    const timestamp = parseFloat(timestampMatch[1]);
    const level = timestampMatch[2];
    const message = timestampMatch[3];
    
    // Track getSession operations
    if (message.includes('[PERF] getSession')) {
      const durationMatch = message.match(/(\d+)ms/);
      const poolMatch = message.match(/pool: (\d+), available: (\d+), inUse: (\d+)/);
      if (durationMatch) {
        getSessionTimes.push(parseFloat(durationMatch[1]));
      }
      if (poolMatch) {
        poolStates.push({
          timestamp,
          total: parseInt(poolMatch[1]),
          available: parseInt(poolMatch[2]),
          inUse: parseInt(poolMatch[3])
        });
      }
    }
    
    // Track insertTablet start
    if (message.includes('[PERF] insertTableTablet START') || message.includes('[PERF] insertTreeTablet START')) {
      operations.push({ start: timestamp, end: null });
      totalOperations++;
    }
    
    // Track insertTablet completion
    if (message.includes('[PERF] RPC call:') || message.includes('Total:')) {
      const durationMatch = message.match(/Total: (\d+)ms/);
      if (durationMatch) {
        const duration = parseFloat(durationMatch[1]);
        insertTimes.push(duration);
        
        // Find corresponding start operation
        for (let i = operations.length - 1; i >= 0; i--) {
          if (operations[i].end === null) {
            operations[i].end = timestamp;
            break;
          }
        }
        
        // Extract RPC time
        const rpcMatch = message.match(/RPC call: (\d+)ms/);
        if (rpcMatch) {
          rpcTimes.push(parseFloat(rpcMatch[1]));
        }
      }
    }
    
    // Calculate current concurrency
    const active = operations.filter(op => {
      return op.start <= timestamp && (op.end === null || op.end >= timestamp);
    }).length;
    
    if (active > maxConcurrency) {
      maxConcurrency = active;
    }
  }
  
  // Analyze results
  console.log('\n📊 CONCURRENCY ANALYSIS');
  console.log('='.repeat(80));
  
  console.log('\n[Active Operations]');
  console.log(`  Total Operations:     ${totalOperations}`);
  console.log(`  Max Concurrency:      ${maxConcurrency} operations running simultaneously`);
  console.log(`  Expected Concurrency: 100 clients (from config)`);
  
  if (maxConcurrency < 10) {
    console.log(`  ⚠️  PROBLEM: Actual concurrency (${maxConcurrency}) << Expected (100)`);
    console.log(`      Operations are mostly SEQUENTIAL, not parallel!`);
  } else if (maxConcurrency < 50) {
    console.log(`  ⚠️  WARNING: Low concurrency - only ${(maxConcurrency/100*100).toFixed(1)}% of expected`);
  } else if (maxConcurrency < 90) {
    console.log(`  ℹ️  Moderate concurrency - ${(maxConcurrency/100*100).toFixed(1)}% of expected`);
  } else {
    console.log(`  ✅ Good concurrency - ${(maxConcurrency/100*100).toFixed(1)}% of expected`);
  }
  
  // Analyze pool state
  if (poolStates.length > 0) {
    console.log('\n[Session Pool State]');
    const avgInUse = poolStates.reduce((sum, s) => sum + s.inUse, 0) / poolStates.length;
    const maxInUse = Math.max(...poolStates.map(s => s.inUse));
    const avgAvailable = poolStates.reduce((sum, s) => sum + s.available, 0) / poolStates.length;
    
    console.log(`  Average In-Use:       ${avgInUse.toFixed(1)} sessions`);
    console.log(`  Max In-Use:           ${maxInUse} sessions`);
    console.log(`  Average Available:    ${avgAvailable.toFixed(1)} sessions`);
    console.log(`  Pool Utilization:     ${(avgInUse/(avgInUse+avgAvailable)*100).toFixed(1)}%`);
    
    if (maxInUse < 10) {
      console.log(`  ⚠️  Pool under-utilized! Only ${maxInUse} sessions used (max: 100)`);
    }
  }
  
  // Analyze timing
  if (getSessionTimes.length > 0) {
    console.log('\n[GetSession Performance]');
    const avgGetSession = getSessionTimes.reduce((a, b) => a + b, 0) / getSessionTimes.length;
    const maxGetSession = Math.max(...getSessionTimes);
    console.log(`  Average:              ${avgGetSession.toFixed(2)}ms`);
    console.log(`  Max:                  ${maxGetSession}ms`);
    
    if (avgGetSession > 5) {
      console.log(`  ⚠️  Slow session acquisition may limit concurrency`);
    }
  }
  
  if (insertTimes.length > 0) {
    console.log('\n[Insert Operation Timing]');
    const avgInsert = insertTimes.reduce((a, b) => a + b, 0) / insertTimes.length;
    const minInsert = Math.min(...insertTimes);
    const maxInsert = Math.max(...insertTimes);
    console.log(`  Sample Count:         ${insertTimes.length}`);
    console.log(`  Average:              ${avgInsert.toFixed(2)}ms`);
    console.log(`  Min:                  ${minInsert}ms`);
    console.log(`  Max:                  ${maxInsert}ms`);
  }
  
  if (rpcTimes.length > 0) {
    console.log('\n[RPC Timing]');
    const avgRpc = rpcTimes.reduce((a, b) => a + b, 0) / rpcTimes.length;
    const minRpc = Math.min(...rpcTimes);
    const maxRpc = Math.max(...rpcTimes);
    console.log(`  Sample Count:         ${rpcTimes.length}`);
    console.log(`  Average:              ${avgRpc.toFixed(2)}ms`);
    console.log(`  Min:                  ${minRpc}ms`);
    console.log(`  Max:                  ${maxRpc}ms`);
  }
  
  // Diagnose concurrency issues
  console.log('\n🔍 DIAGNOSIS');
  console.log('='.repeat(80));
  
  if (maxConcurrency < 10) {
    console.log('\n⚠️  CRITICAL: Sequential Execution Detected!');
    console.log('\nPossible Causes:');
    console.log('1. ❌ Benchmark uses sequential loops instead of Promise.all()');
    console.log('2. ❌ await inside loops blocks concurrency');
    console.log('3. ❌ Session pool bottleneck (waiting for available sessions)');
    console.log('4. ❌ Single database/table lock on server side');
    
    console.log('\nRecommended Solutions:');
    console.log('1. ✅ Use Promise.all() to launch all clients simultaneously');
    console.log('2. ✅ Use separate tables per client to avoid lock contention');
    console.log('3. ✅ Increase pool size to match client count');
    console.log('4. ✅ Profile server-side locking behavior');
  } else if (maxConcurrency < 50) {
    console.log('\n⚠️  WARNING: Low Concurrency');
    console.log('\nLikely bottlenecks:');
    console.log('- Session pool size too small');
    console.log('- Database-level locking');
    console.log('- Network bandwidth saturation');
    
    console.log('\nRecommendations:');
    console.log('- Monitor pool growth: should reach 100 sessions quickly');
    console.log('- Use separate tables/databases per client');
    console.log('- Check network utilization');
  }
  
  // Throughput estimate
  if (insertTimes.length > 0 && maxConcurrency > 0) {
    console.log('\n📈 THROUGHPUT ANALYSIS');
    console.log('='.repeat(80));
    
    const avgInsert = insertTimes.reduce((a, b) => a + b, 0) / insertTimes.length;
    const sequentialOpsPerSec = 1000 / avgInsert;
    const parallelOpsPerSec = (1000 / avgInsert) * maxConcurrency;
    
    console.log(`\nSequential Throughput: ${sequentialOpsPerSec.toFixed(2)} ops/s`);
    console.log(`Parallel Throughput:   ${parallelOpsPerSec.toFixed(2)} ops/s (${maxConcurrency}x concurrency)`);
    console.log(`Theoretical Max:       ${(1000 / avgInsert * 100).toFixed(2)} ops/s (100x concurrency)`);
    
    const efficiency = (maxConcurrency / 100) * 100;
    console.log(`\nConcurrency Efficiency: ${efficiency.toFixed(1)}%`);
    
    if (efficiency < 50) {
      console.log('⚠️  Low efficiency suggests sequential execution or severe bottleneck');
    }
  }
  
  console.log('\n' + '='.repeat(80));
  
} catch (error) {
  console.error('Error analyzing log file:', error.message);
  process.exit(1);
}
