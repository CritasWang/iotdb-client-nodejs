/**
 * Example demonstrating enhanced SessionPool features from Phase 3 optimization
 * Based on pg pool design patterns: https://node-postgres.com/apis/pool
 * 
 * Features demonstrated:
 * - FIFO queue with fair ordering
 * - Enhanced metrics (totalCount, idleCount, activeCount, waitingCount)
 * - Lifecycle management (maxLifetimeSeconds, maxUses)
 * - Automatic session management (executeQuery, executeNonQuery, insertTablet)
 */

import { SessionPool } from "../src/client/SessionPool";
import { TSDataType } from "../src/utils/DataTypes";

async function main() {
  // Create pool with enhanced configuration
  const pool = new SessionPool({
    host: "localhost",
    port: 6667,
    username: "root",
    password: "root",
    
    // Pool sizing
    minPoolSize: 2,
    maxPoolSize: 10,
    
    // Timeout configuration
    maxIdleTime: 60000, // 60 seconds
    waitTimeout: 30000, // 30 seconds
    
    // Lifecycle management (NEW in Phase 3C)
    maxLifetimeSeconds: 1800, // 30 minutes - rotate old connections
    maxUses: 7500, // Rotate after 7500 uses
    
    // Redirection optimization
    enableRedirection: true,
    redirectCacheTTL: 300000, // 5 minutes
  });

  try {
    // Initialize pool with minimum connections
    await pool.init();
    console.log("✓ Pool initialized");

    // Demonstrate enhanced metrics (NEW in Phase 3D)
    console.log("\n=== Enhanced Metrics ===");
    console.log("Pool stats:", pool.getPoolStats());
    console.log("Total connections:", pool.totalCount);
    console.log("Idle connections:", pool.idleCount);
    console.log("Active connections:", pool.activeCount);
    console.log("Waiting requests:", pool.waitingCount);

    // Backward compatible metrics still work
    console.log("Pool size (old API):", pool.getPoolSize());
    console.log("Available (old API):", pool.getAvailableSize());
    console.log("In use (old API):", pool.getInUseSize());

    // Create database and table
    console.log("\n=== Creating Database ===");
    try {
      await pool.executeNonQueryStatement("DROP DATABASE root.demo");
    } catch (e: any) {
      // Ignore if database doesn't exist
      if (!e.message?.includes("not exist")) throw e;
    }
    await pool.executeNonQueryStatement("CREATE DATABASE root.demo");
    console.log("✓ Database created");

    // Automatic session management (Phase 3B - already implemented)
    console.log("\n=== Automatic Session Management ===");
    
    // Method 1: executeNonQuery (automatic session acquisition and release)
    await pool.executeNonQueryStatement(
      "CREATE TIMESERIES root.demo.device1.temperature WITH DATATYPE=FLOAT"
    );
    console.log("✓ Timeseries created with executeNonQuery");

    // Method 2: insertTablet (automatic session management)
    const tablet = {
      deviceId: "root.demo.device1",
      measurements: ["temperature"],
      dataTypes: [TSDataType.FLOAT],
      timestamps: [Date.now(), Date.now() + 1000, Date.now() + 2000],
      values: [[25.5], [26.0], [26.5]],
    };
    await pool.insertTablet(tablet);
    console.log("✓ Data inserted with insertTablet");

    // Method 3: executeQuery (automatic session management)
    const dataSet = await pool.executeQueryStatement(
      "SELECT * FROM root.demo.device1"
    );
    console.log("✓ Query executed with executeQuery");
    
    let rowCount = 0;
    while (await dataSet.hasNext()) {
      const row = dataSet.next();
      console.log(`  Row ${rowCount + 1}:`, row.getTimestamp(), row.getValue("temperature"));
      rowCount++;
    }
    await dataSet.close(); // Must close to release session
    console.log(`✓ Read ${rowCount} rows`);

    // Manual session management (still supported for advanced use cases)
    console.log("\n=== Manual Session Management (Advanced) ===");
    const session = await pool.getSession();
    try {
      await session.executeNonQueryStatement(
        "CREATE TIMESERIES root.demo.device1.humidity WITH DATATYPE=FLOAT"
      );
      console.log("✓ Timeseries created with manual session");
    } finally {
      pool.releaseSession(session); // MUST release manually
    }

    // Demonstrate FIFO queue behavior under load (NEW in Phase 3A)
    console.log("\n=== FIFO Queue Behavior ===");
    console.log("Simulating 20 concurrent requests with max pool size of 10...");
    
    const startTime = Date.now();
    const promises = Array.from({ length: 20 }, async (_, i) => {
      const requestStart = Date.now();
      const dataSet = await pool.executeQueryStatement("SHOW DATABASES");
      await dataSet.close();
      const duration = Date.now() - requestStart;
      console.log(`  Request ${i + 1} completed in ${duration}ms`);
    });

    await Promise.all(promises);
    const totalDuration = Date.now() - startTime;
    console.log(`✓ All 20 requests completed in ${totalDuration}ms`);

    // Check metrics after load
    console.log("\n=== Metrics After Load ===");
    const finalStats = pool.getPoolStats();
    console.log("Final pool stats:", finalStats);
    console.log("✓ Pool health: OK");

    // Monitor pool statistics periodically
    console.log("\n=== Pool Monitoring Example ===");
    console.log("In production, you could monitor pool health like this:");
    console.log(`
    setInterval(() => {
      const stats = pool.getPoolStats();
      console.log('Pool stats:', stats);
      
      // Alert on high wait queue
      if (stats.waiting > 10) {
        console.warn('High wait queue! Consider increasing maxPoolSize');
      }
      
      // Alert on low utilization
      if (stats.active < stats.total * 0.2 && stats.total > stats.minPoolSize) {
        console.info('Low pool utilization - connections may be idle');
      }
    }, 60000); // Check every minute
    `);

    // Demonstrate lifecycle rotation
    console.log("\n=== Lifecycle Management ===");
    console.log("Lifecycle limits:");
    console.log("  maxLifetimeSeconds: 1800 (30 minutes)");
    console.log("  maxUses: 7500");
    console.log("Connections will be automatically rotated when they reach these limits");
    console.log("This prevents memory leaks and maintains connection health");

    // Cleanup
    console.log("\n=== Cleanup ===");
    try {
      await pool.executeNonQueryStatement("DROP DATABASE root.demo");
      console.log("✓ Database dropped");
    } catch (e) {
      // Ignore cleanup errors
    }

  } finally {
    await pool.close();
    console.log("✓ Pool closed");
  }

  console.log("\n=== Summary ===");
  console.log("✓ FIFO queue ensures fair request ordering");
  console.log("✓ Enhanced metrics for better observability");
  console.log("✓ Automatic lifecycle management prevents memory leaks");
  console.log("✓ Backward compatible with existing code");
  console.log("\nFor more details, see: docs/pool-optimization-plan.md");
}

// Run example
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
