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
 * Serialization Worker for parallel tablet serialization
 * Uses Worker Threads for true multi-threaded CPU-bound work
 */

import { parentPort, workerData } from "worker_threads";

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

/**
 * Optimized column serialization (same as Session.serializeColumn but standalone)
 */
function serializeColumn(values: any[], dataType: number): Buffer {
  switch (dataType) {
    case 0: // BOOLEAN
      return Buffer.from(
        values.map((v) => (v === null || v === undefined ? 0 : v ? 1 : 0)),
      );

    case 1: {
      // INT32
      const buffer = Buffer.alloc(values.length * 4);

      // Check if there are any nulls
      let hasNulls = false;
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null || values[i] === undefined) {
          hasNulls = true;
          break;
        }
      }

      if (!hasNulls) {
        // Fast path: no null checks needed
        for (let i = 0; i < values.length; i++) {
          buffer.writeInt32BE(values[i], i * 4);
        }
      } else {
        // Slow path: with null checks
        for (let i = 0; i < values.length; i++) {
          buffer.writeInt32BE(
            values[i] === null || values[i] === undefined ? 0 : values[i],
            i * 4,
          );
        }
      }
      return buffer;
    }

    case 2: {
      // INT64
      const buffer = Buffer.alloc(values.length * 8);

      let hasNulls = false;
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null || values[i] === undefined) {
          hasNulls = true;
          break;
        }
      }

      if (!hasNulls) {
        for (let i = 0; i < values.length; i++) {
          buffer.writeBigInt64BE(
            typeof values[i] === "bigint" ? values[i] : BigInt(values[i]),
            i * 8,
          );
        }
      } else {
        for (let i = 0; i < values.length; i++) {
          buffer.writeBigInt64BE(
            values[i] === null || values[i] === undefined
              ? BigInt(0)
              : BigInt(values[i]),
            i * 8,
          );
        }
      }
      return buffer;
    }

    case 3: {
      // FLOAT
      const buffer = Buffer.alloc(values.length * 4);

      let hasNulls = false;
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null || values[i] === undefined) {
          hasNulls = true;
          break;
        }
      }

      if (!hasNulls) {
        for (let i = 0; i < values.length; i++) {
          buffer.writeFloatBE(values[i], i * 4);
        }
      } else {
        for (let i = 0; i < values.length; i++) {
          buffer.writeFloatBE(
            values[i] === null || values[i] === undefined ? 0.0 : values[i],
            i * 4,
          );
        }
      }
      return buffer;
    }

    case 4: {
      // DOUBLE
      const buffer = Buffer.alloc(values.length * 8);

      let hasNulls = false;
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null || values[i] === undefined) {
          hasNulls = true;
          break;
        }
      }

      if (!hasNulls) {
        for (let i = 0; i < values.length; i++) {
          buffer.writeDoubleBE(values[i], i * 8);
        }
      } else {
        for (let i = 0; i < values.length; i++) {
          buffer.writeDoubleBE(
            values[i] === null || values[i] === undefined ? 0.0 : values[i],
            i * 8,
          );
        }
      }
      return buffer;
    }

    case 5: // TEXT
    case 11: {
      // STRING
      const strData: Buffer[] = [];
      let totalSize = 0;

      for (const v of values) {
        const str = v === null || v === undefined ? "" : String(v);
        const strBytes = Buffer.from(str, "utf8");
        strData.push(strBytes);
        totalSize += 4 + strBytes.length;
      }

      const result = Buffer.allocUnsafe(totalSize);
      let offset = 0;

      for (const strBytes of strData) {
        result.writeInt32BE(strBytes.length, offset);
        offset += 4;
        strBytes.copy(result, offset);
        offset += strBytes.length;
      }

      return result;
    }

    case 8: {
      // TIMESTAMP
      const buffer = Buffer.alloc(values.length * 8);
      for (let i = 0; i < values.length; i++) {
        let timestamp = BigInt(0);
        const v = values[i];
        if (v !== null && v !== undefined) {
          if (v instanceof Date) {
            timestamp = BigInt(v.getTime());
          } else {
            timestamp = BigInt(v);
          }
        }
        buffer.writeBigInt64BE(timestamp, i * 8);
      }
      return buffer;
    }

    case 9: {
      // DATE
      const buffer = Buffer.alloc(values.length * 4);
      for (let i = 0; i < values.length; i++) {
        let days = 0;
        const v = values[i];
        if (v !== null && v !== undefined) {
          if (v instanceof Date) {
            days = Math.floor(v.getTime() / (24 * 60 * 60 * 1000));
          } else {
            days = v;
          }
        }
        buffer.writeInt32BE(days, i * 4);
      }
      return buffer;
    }

    case 10: {
      // BLOB
      const blobData: Buffer[] = [];
      let totalSize = 0;

      for (const v of values) {
        const blob =
          v === null || v === undefined
            ? Buffer.alloc(0)
            : Buffer.isBuffer(v)
              ? v
              : Buffer.from(v);
        blobData.push(blob);
        totalSize += 4 + blob.length;
      }

      const result = Buffer.allocUnsafe(totalSize);
      let offset = 0;

      for (const blob of blobData) {
        result.writeInt32BE(blob.length, offset);
        offset += 4;
        blob.copy(result, offset);
        offset += blob.length;
      }

      return result;
    }

    default:
      throw new Error(`Unsupported data type: ${dataType}`);
  }
}

// Worker thread message handler
if (parentPort) {
  parentPort.on("message", (task: SerializationTask) => {
    try {
      const buffer = serializeColumn(task.values, task.dataType);

      const result: SerializationResult = {
        taskId: task.taskId,
        columnIndex: task.columnIndex,
        buffer: buffer,
      };

      parentPort!.postMessage(result);
    } catch (error: any) {
      const result: SerializationResult = {
        taskId: task.taskId,
        columnIndex: task.columnIndex,
        buffer: Buffer.alloc(0),
        error: error.message,
      };

      parentPort!.postMessage(result);
    }
  });
}
