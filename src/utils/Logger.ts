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

import { performance } from "perf_hooks";

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel;
  private includeTimestamp: boolean;
  private includeAsyncId: boolean;
  private startTime: number;

  constructor() {
    // Allow configuration via environment variable
    const envLevel = process.env.LOG_LEVEL?.toUpperCase();
    this.level =
      envLevel && envLevel in LogLevel
        ? LogLevel[envLevel as keyof typeof LogLevel]
        : LogLevel.INFO;

    // Enable high-precision timestamp for debug level
    this.includeTimestamp =
      process.env.LOG_TIMESTAMP === "true" || this.level === LogLevel.DEBUG;

    // Enable async context ID tracking
    this.includeAsyncId =
      process.env.LOG_ASYNC_ID === "true" || this.level === LogLevel.DEBUG;

    // Record start time for relative timestamps
    this.startTime = performance.now();
  }

  setLevel(level: LogLevel) {
    this.level = level;
    // Auto-enable timestamp for DEBUG level
    if (level === LogLevel.DEBUG) {
      this.includeTimestamp = true;
      this.includeAsyncId = true;
    }
  }

  /**
   * Get current async context ID (similar to thread ID in multi-threaded environments)
   * In Node.js, each async operation has a unique execution context
   */
  private getAsyncId(): number {
    // Use async_hooks to get current async resource ID
    try {
      const asyncHooks = require("async_hooks");
      return asyncHooks.executionAsyncId();
    } catch {
      // Fallback if async_hooks not available
      return 0;
    }
  }

  /**
   * Format log prefix with high-precision timestamp and async ID
   */
  private formatPrefix(level: string): string {
    const parts: string[] = [];

    // Add timestamp (microsecond precision, relative to start)
    if (this.includeTimestamp) {
      const elapsed = performance.now() - this.startTime;
      const seconds = Math.floor(elapsed / 1000);
      const microseconds = Math.floor((elapsed % 1000) * 1000);
      parts.push(
        `${seconds.toString().padStart(6, "0")}.${microseconds.toString().padStart(6, "0")}`,
      );
    }

    // Add async context ID (similar to thread ID)
    if (this.includeAsyncId) {
      const asyncId = this.getAsyncId();
      parts.push(`[${asyncId.toString().padStart(6, "0")}]`);
    }

    // Add log level
    parts.push(`[${level}]`);

    return parts.join(" ");
  }

  debug(message: string, ...args: unknown[]) {
    if (this.level <= LogLevel.DEBUG) {
      console.log(`${this.formatPrefix("DEBUG")} ${message}`, ...args);
    }
  }

  info(message: string, ...args: unknown[]) {
    if (this.level <= LogLevel.INFO) {
      console.log(`${this.formatPrefix("INFO")} ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]) {
    if (this.level <= LogLevel.WARN) {
      console.warn(`${this.formatPrefix("WARN")} ${message}`, ...args);
    }
  }

  error(message: string, ...args: unknown[]) {
    if (this.level <= LogLevel.ERROR) {
      console.error(`${this.formatPrefix("ERROR")} ${message}`, ...args);
    }
  }
}

export const logger = new Logger();
export { LogLevel };
