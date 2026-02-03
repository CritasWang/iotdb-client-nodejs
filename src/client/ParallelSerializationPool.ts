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
 * Parallel Serialization Pool using Worker Threads
 * Provides true multi-threaded CPU-bound work for tablet serialization
 */

import { Worker } from "worker_threads";
import * as path from "path";
import * as os from "os";
import { logger } from "../utils/Logger";

interface SerializationTask {
  taskId: string;
  columnIndex: number;
  values: any[];
  dataType: number;
}

interface SerializationResult {
  taskId: string;
  columnIndex: number;
  buffer: Buffer;
  error?: string;
}

interface PendingTask {
  resolve: (buffer: Buffer) => void;
  reject: (error: Error) => void;
}

export class ParallelSerializationPool {
  private workers: Worker[] = [];
  private workerIndex = 0;
  private pendingTasks: Map<string, PendingTask> = new Map();
  private nextTaskId = 0;
  private workerPath: string;

  constructor(workerCount?: number) {
    const cpuCount = os.cpus().length;
    const numWorkers = workerCount || Math.min(cpuCount, 8); // Max 8 workers

    // Worker script path - check both compiled and source locations
    const compiledPath = path.join(__dirname, "SerializationWorker.js");
    this.workerPath = compiledPath;

    logger.info(
      `Initializing parallel serialization pool with ${numWorkers} workers (${cpuCount} CPUs available)`,
    );

    for (let i = 0; i < numWorkers; i++) {
      this.createWorker(i);
    }
  }

  private createWorker(id: number): void {
    try {
      const worker = new Worker(this.workerPath);

      worker.on("message", (result: SerializationResult) => {
        const pending = this.pendingTasks.get(result.taskId);
        if (pending) {
          this.pendingTasks.delete(result.taskId);

          if (result.error) {
            pending.reject(new Error(result.error));
          } else {
            pending.resolve(result.buffer);
          }
        }
      });

      worker.on("error", (error) => {
        logger.error(`Worker ${id} error:`, error);
        // Recreate worker
        this.workers[id] = this.createWorkerReplacement(id);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          logger.warn(`Worker ${id} exited with code ${code}, recreating...`);
          this.workers[id] = this.createWorkerReplacement(id);
        }
      });

      this.workers.push(worker);
      logger.debug(`Worker ${id} created successfully`);
    } catch (error) {
      logger.error(`Failed to create worker ${id}:`, error);
      throw error;
    }
  }

  private createWorkerReplacement(id: number): Worker {
    const worker = new Worker(this.workerPath);

    worker.on("message", (result: SerializationResult) => {
      const pending = this.pendingTasks.get(result.taskId);
      if (pending) {
        this.pendingTasks.delete(result.taskId);

        if (result.error) {
          pending.reject(new Error(result.error));
        } else {
          pending.resolve(result.buffer);
        }
      }
    });

    worker.on("error", (error) => {
      logger.error(`Replacement worker ${id} error:`, error);
    });

    return worker;
  }

  /**
   * Serialize a single column using next available worker (round-robin)
   */
  async serializeColumn(
    columnIndex: number,
    values: any[],
    dataType: number,
  ): Promise<Buffer> {
    const taskId = `${++this.nextTaskId}`;

    const task: SerializationTask = {
      taskId,
      columnIndex,
      values,
      dataType,
    };

    return new Promise<Buffer>((resolve, reject) => {
      this.pendingTasks.set(taskId, { resolve, reject });

      // Round-robin worker selection
      const worker = this.workers[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workers.length;

      worker.postMessage(task);
    });
  }

  /**
   * Serialize multiple columns in parallel across all workers
   * This is the key optimization - distribute columns to workers
   */
  async serializeColumnsParallel(
    values: any[][],
    dataTypes: number[],
  ): Promise<Buffer[]> {
    const startTime = Date.now();

    // Create tasks for all columns
    const tasks: Promise<Buffer>[] = [];

    for (let colIndex = 0; colIndex < dataTypes.length; colIndex++) {
      const dataType = dataTypes[colIndex];
      const columnValues = values.map((row) => row[colIndex]);

      tasks.push(this.serializeColumn(colIndex, columnValues, dataType));
    }

    // Wait for all columns to serialize in parallel
    const buffers = await Promise.all(tasks);

    const duration = Date.now() - startTime;
    logger.debug(
      `[PERF] Parallel serialization: ${duration}ms for ${dataTypes.length} columns`,
    );

    return buffers;
  }

  /**
   * Terminate all workers
   */
  async terminate(): Promise<void> {
    logger.info("Terminating parallel serialization pool...");

    const terminationPromises = this.workers.map((worker) =>
      worker.terminate(),
    );

    await Promise.all(terminationPromises);
    this.workers = [];
    this.pendingTasks.clear();

    logger.info("Parallel serialization pool terminated");
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      workerCount: this.workers.length,
      pendingTasks: this.pendingTasks.size,
    };
  }
}

// Singleton instance for reuse across sessions
let globalSerializationPool: ParallelSerializationPool | null = null;

/**
 * Get or create the global serialization pool
 */
export function getSerializationPool(): ParallelSerializationPool {
  if (!globalSerializationPool) {
    globalSerializationPool = new ParallelSerializationPool();
  }
  return globalSerializationPool;
}

/**
 * Terminate the global serialization pool
 */
export async function terminateSerializationPool(): Promise<void> {
  if (globalSerializationPool) {
    await globalSerializationPool.terminate();
    globalSerializationPool = null;
  }
}
