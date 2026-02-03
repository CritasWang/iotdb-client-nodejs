/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Analyze performance logs with high-precision timestamps and async IDs
 * 
 * Usage:
 *   node benchmark/analyze-perf-logs.js < /tmp/benchmark-debug-YYYYMMDD-HHMMSS.log
 */

const fs = require('fs');
const readline = require('readline');

class PerfLogAnalyzer {
  constructor() {
    this.rpcLatencies = [];
    this.serializeLatencies = [];
    this.totalLatencies = [];
    this.asyncIdStats = new Map();
    this.timestampStart = null;
    this.timestampEnd = null;
  }

  parseTimestamp(line) {
    const match = line.match(/^(\d+\.\d+) \[(\d+)\]/);
    if (match) {
      return {
        timestamp: parseFloat(match[1]),
        asyncId: parseInt(match[2])
      };
    }
    return null;
  }

  parseRpcLine(line) {
    // Example: 000002.876238 [000031] [DEBUG] [PERF] RPC call: 1257ms, Total: 1264ms (serialize: 7ms)
    const match = line.match(/RPC call: (\d+)ms, Total: (\d+)ms \(serialize: (\d+)ms\)/);
    if (match) {
      return {
        rpc: parseInt(match[1]),
        total: parseInt(match[2]),
        serialize: parseInt(match[3])
      };
    }
    return null;
  }

  analyzeLine(line) {
    if (!line.includes('[PERF]')) return;

    const tsInfo = this.parseTimestamp(line);
    if (!tsInfo) return;

    // Track timestamp range
    if (this.timestampStart === null || tsInfo.timestamp < this.timestampStart) {
      this.timestampStart = tsInfo.timestamp;
    }
    if (this.timestampEnd === null || tsInfo.timestamp > this.timestampEnd) {
      this.timestampEnd = tsInfo.timestamp;
    }

    // Track async ID stats
    if (!this.asyncIdStats.has(tsInfo.asyncId)) {
      this.asyncIdStats.set(tsInfo.asyncId, { count: 0, totalRpc: 0 });
    }

    // Parse RPC line
    const rpcData = this.parseRpcLine(line);
    if (rpcData) {
      this.rpcLatencies.push(rpcData.rpc);
      this.totalLatencies.push(rpcData.total);
      this.serializeLatencies.push(rpcData.serialize);

      const stats = this.asyncIdStats.get(tsInfo.asyncId);
      stats.count++;
      stats.totalRpc += rpcData.rpc;
    }
  }

  calculateStats(arr) {
    if (arr.length === 0) return null;

    arr.sort((a, b) => a - b);
    return {
      count: arr.length,
      min: arr[0],
      max: arr[arr.length - 1],
      avg: arr.reduce((sum, val) => sum + val, 0) / arr.length,
      p50: arr[Math.floor(arr.length * 0.5)],
      p90: arr[Math.floor(arr.length * 0.9)],
      p95: arr[Math.floor(arr.length * 0.95)],
      p99: arr[Math.floor(arr.length * 0.99)],
    };
  }

  printReport() {
    console.log('='.repeat(80));
    console.log('PERFORMANCE LOG ANALYSIS');
    console.log('='.repeat(80));
    console.log();

    // Time range
    if (this.timestampStart !== null && this.timestampEnd !== null) {
      console.log('[Time Range]');
      console.log(`  Start:          ${this.timestampStart.toFixed(6)}s`);
      console.log(`  End:            ${this.timestampEnd.toFixed(6)}s`);
      console.log(`  Duration:       ${(this.timestampEnd - this.timestampStart).toFixed(6)}s`);
      console.log();
    }

    // RPC latency stats
    const rpcStats = this.calculateStats(this.rpcLatencies);
    if (rpcStats) {
      console.log('[RPC Latency]');
      console.log(`  Operations:     ${rpcStats.count}`);
      console.log(`  Min:            ${rpcStats.min}ms`);
      console.log(`  Max:            ${rpcStats.max}ms`);
      console.log(`  Average:        ${rpcStats.avg.toFixed(2)}ms`);
      console.log(`  P50 (Median):   ${rpcStats.p50}ms`);
      console.log(`  P90:            ${rpcStats.p90}ms`);
      console.log(`  P95:            ${rpcStats.p95}ms`);
      console.log(`  P99:            ${rpcStats.p99}ms`);
      console.log();
    }

    // Serialization latency stats
    const serStats = this.calculateStats(this.serializeLatencies);
    if (serStats) {
      console.log('[Serialization Latency]');
      console.log(`  Operations:     ${serStats.count}`);
      console.log(`  Min:            ${serStats.min}ms`);
      console.log(`  Max:            ${serStats.max}ms`);
      console.log(`  Average:        ${serStats.avg.toFixed(2)}ms`);
      console.log(`  P50 (Median):   ${serStats.p50}ms`);
      console.log(`  P90:            ${serStats.p90}ms`);
      console.log(`  P95:            ${serStats.p95}ms`);
      console.log(`  P99:            ${serStats.p99}ms`);
      console.log();
    }

    // Total latency stats
    const totalStats = this.calculateStats(this.totalLatencies);
    if (totalStats) {
      console.log('[Total Latency]');
      console.log(`  Operations:     ${totalStats.count}`);
      console.log(`  Min:            ${totalStats.min}ms`);
      console.log(`  Max:            ${totalStats.max}ms`);
      console.log(`  Average:        ${totalStats.avg.toFixed(2)}ms`);
      console.log(`  P50 (Median):   ${totalStats.p50}ms`);
      console.log(`  P90:            ${totalStats.p90}ms`);
      console.log(`  P95:            ${totalStats.p95}ms`);
      console.log(`  P99:            ${totalStats.p99}ms`);
      console.log();
    }

    // Async ID distribution
    if (this.asyncIdStats.size > 0) {
      console.log('[Async Context Distribution]');
      console.log(`  Unique Contexts: ${this.asyncIdStats.size}`);
      
      // Sort by RPC count
      const sortedIds = Array.from(this.asyncIdStats.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10); // Top 10

      console.log('  Top 10 Contexts:');
      sortedIds.forEach(([asyncId, stats]) => {
        const avgRpc = stats.count > 0 ? (stats.totalRpc / stats.count).toFixed(2) : 0;
        console.log(`    [${asyncId.toString().padStart(6, '0')}]: ${stats.count} ops, avg RPC ${avgRpc}ms`);
      });
      console.log();
    }

    // Performance insights
    if (rpcStats && serStats && totalStats) {
      console.log('[Performance Insights]');
      const rpcPercent = (rpcStats.avg / totalStats.avg * 100).toFixed(1);
      const serPercent = (serStats.avg / totalStats.avg * 100).toFixed(1);
      console.log(`  RPC overhead:       ${rpcPercent}% of total latency`);
      console.log(`  Serialize overhead: ${serPercent}% of total latency`);
      
      if (rpcStats.avg > 100) {
        console.log(`  ⚠️  High RPC latency detected (avg ${rpcStats.avg.toFixed(2)}ms)`);
        console.log(`      This indicates network or server processing bottleneck`);
      }
      
      if (serStats.avg > 10) {
        console.log(`  ⚠️  High serialization latency detected (avg ${serStats.avg.toFixed(2)}ms)`);
        console.log(`      Consider optimizing data serialization`);
      }
      
      if (serStats.avg < 10 && rpcStats.avg > serStats.avg * 10) {
        console.log(`  ✓  Serialization is optimized (${serStats.avg.toFixed(2)}ms avg)`);
        console.log(`  ✗  Network/server is the bottleneck (${rpcStats.avg.toFixed(2)}ms avg)`);
      }
      console.log();
    }

    console.log('='.repeat(80));
  }
}

// Main
async function main() {
  const analyzer = new PerfLogAnalyzer();

  // Read from stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  for await (const line of rl) {
    analyzer.analyzeLine(line);
  }

  analyzer.printReport();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
