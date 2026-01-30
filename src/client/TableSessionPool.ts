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

import { TableSession } from "./TableSession";
import { Session, TableTablet, TreeTablet } from "./Session";
import { PoolConfig, SQL_DIALECT_TABLE, InternalConfig } from "../utils/Config";
import { BaseSessionPool } from "./BaseSessionPool";
import { logger } from "../utils/Logger";

/**
 * TableSessionPool provides connection pooling optimized for table model operations
 * Automatically configures sessions for table mode by setting sql_dialect to 'table'
 * Uses TableSession instances which extend Session
 */
export class TableSessionPool extends BaseSessionPool {
  constructor(
    hostsOrConfig: string | string[] | PoolConfig,
    port?: number,
    config?: Partial<PoolConfig>,
  ) {
    super(hostsOrConfig, port, config);
  }

  protected getPoolName(): string {
    return "TableSessionPool";
  }

  protected async createPoolSession(): Promise<Session> {
    const endPoint = this.getNextEndPoint();

    // Create internal config with sql_dialect set to 'table'
    const internalConfig: InternalConfig = {
      ...this.config,
      host: endPoint.host,
      port: endPoint.port,
      sqlDialect: SQL_DIALECT_TABLE,
    };

    try {
      // Create TableSession instance instead of Session
      const session = new TableSession(internalConfig);
      await session.open();

      // If database is configured, automatically USE it (ignore errors)
      // Note: Disabled for now as it may cause hangs
      if (this.config.database) {
        try {
          logger.debug(`Attempting to USE database: ${this.config.database}`);
          await session.executeNonQueryStatement(`USE ${this.config.database}`);
          logger.debug(
            `Successfully set database context to: ${this.config.database}`,
          );
        } catch (error: any) {
          // Ignore errors - database might not exist yet or other issues
          // This is acceptable as operations can still work without pre-set database
          logger.debug(
            `Failed to USE database ${this.config.database}, ignoring error: ${error.message}`,
          );
        }
      }

      return session;
    } catch (error: any) {
      const errorMsg = `Failed to create pool session for ${endPoint.host}:${endPoint.port} - ${error.message}`;
      throw new Error(errorMsg);
    }
  }

  /**
   * Insert tablet (supports both tree and table models, but typically used for TableTablet)
   * @param tablet TreeTablet or TableTablet
   */
  async insertTablet(tablet: TreeTablet | TableTablet): Promise<void> {
    const session = await this.getSession();
    try {
      return await session.insertTablet(tablet);
    } finally {
      this.releaseSession(session);
    }
  }
}

// Re-export types for backward compatibility and new types
export type {
  QueryResult,
  Tablet,
  TreeTablet,
  TableTablet,
  ColumnCategory,
} from "./Session";
export { TableSession } from "./TableSession";
