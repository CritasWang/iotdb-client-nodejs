#!/usr/bin/env node

/**
 * Visualize concurrency from performance logs
 * Shows when different async contexts are active
 */

const fs = require('fs');
const readline = require('readline');

async function visualizeConcurrency(logFile) {
  const events = [];
  
  // Read log file
  const fileStream = fs.createReadStream(logFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    // Parse RPC call lines
    const rpcMatch = line.match(/^(\d+\.\d+) \[(\d+)\].*\[PERF\].*RPC call: (\d+)ms/);
    if (rpcMatch) {
      const timestamp = parseFloat(rpcMatch[1]);
      const asyncId = parseInt(rpcMatch[2]);
      const duration = parseInt(rpcMatch[3]);
      
      events.push({
        asyncId,
        start: timestamp - duration / 1000,
        end: timestamp,
        duration
      });
    }
  }

  if (events.length === 0) {
    console.log('No RPC events found in log file');
    return;
  }

  // Sort by start time
  events.sort((a, b) => a.start - b.start);

  // Find time range
  const minTime = Math.min(...events.map(e => e.start));
  const maxTime = Math.max(...events.map(e => e.end));
  const totalDuration = maxTime - minTime;

  console.log('='.repeat(80));
  console.log('CONCURRENCY VISUALIZATION');
  console.log('='.repeat(80));
  console.log();
  console.log(`Time range: ${minTime.toFixed(3)}s - ${maxTime.toFixed(3)}s`);
  console.log(`Total duration: ${totalDuration.toFixed(3)}s`);
  console.log(`Total RPC calls: ${events.length}`);
  console.log();

  // Group events by async ID
  const asyncGroups = new Map();
  events.forEach(e => {
    if (!asyncGroups.has(e.asyncId)) {
      asyncGroups.set(e.asyncId, []);
    }
    asyncGroups.get(e.asyncId).push(e);
  });

  console.log(`Unique async contexts: ${asyncGroups.size}`);
  console.log();

  // Calculate concurrency over time
  const timeSlots = 100; // Divide time into 100 slots
  const slotSize = totalDuration / timeSlots;
  const concurrency = new Array(timeSlots).fill(0);

  events.forEach(e => {
    const startSlot = Math.floor((e.start - minTime) / slotSize);
    const endSlot = Math.min(Math.floor((e.end - minTime) / slotSize), timeSlots - 1);
    
    for (let i = startSlot; i <= endSlot; i++) {
      concurrency[i]++;
    }
  });

  const maxConcurrency = Math.max(...concurrency);
  const avgConcurrency = concurrency.reduce((sum, c) => sum + c, 0) / timeSlots;

  console.log(`Max concurrency: ${maxConcurrency} simultaneous RPC calls`);
  console.log(`Avg concurrency: ${avgConcurrency.toFixed(2)} simultaneous RPC calls`);
  console.log();

  // ASCII graph
  console.log('Concurrency over time (each column = ' + (totalDuration / timeSlots).toFixed(3) + 's):');
  console.log();
  
  const graphHeight = 20;
  const scale = maxConcurrency / graphHeight;
  
  for (let row = graphHeight; row > 0; row--) {
    const threshold = row * scale;
    let line = String(Math.ceil(threshold)).padStart(3) + ' │';
    
    for (let col = 0; col < timeSlots; col++) {
      if (concurrency[col] >= threshold) {
        line += '█';
      } else if (concurrency[col] >= threshold - scale / 2) {
        line += '▄';
      } else {
        line += ' ';
      }
    }
    console.log(line);
  }
  
  console.log('  0 └' + '─'.repeat(timeSlots));
  console.log('     ' + '0s'.padEnd(timeSlots / 2) + (totalDuration / 2).toFixed(1) + 's'.padEnd(timeSlots / 2 - 5) + totalDuration.toFixed(1) + 's');
  console.log();

  // Distribution of async IDs
  console.log('Top 10 async contexts by RPC count:');
  const sorted = Array.from(asyncGroups.entries())
    .map(([id, events]) => ({
      id,
      count: events.length,
      totalDuration: events.reduce((sum, e) => sum + e.duration, 0),
      avgDuration: events.reduce((sum, e) => sum + e.duration, 0) / events.length
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  sorted.forEach(({ id, count, avgDuration }) => {
    console.log(`  [${id.toString().padStart(6, '0')}]: ${count} calls, avg ${avgDuration.toFixed(1)}ms`);
  });
  console.log();

  console.log('='.repeat(80));
}

// Main
const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: node visualize-concurrency.js <log-file>');
  process.exit(1);
}

visualizeConcurrency(logFile).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
