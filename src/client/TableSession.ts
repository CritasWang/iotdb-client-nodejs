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

import { Session, TableTablet, ColumnCategory } from './Session';
import { logger } from '../utils/Logger';

const ttypes = require("../thrift/generated/client_types");

/**
 * TableSession extends Session for table model operations
 * Automatically configured for table mode via sql_dialect
 */
export class TableSession extends Session {
  /**
   * Insert table model tablet
   * @param tablet TableTablet with tableName, columnNames, columnTypes, columnCategories, timestamps, values
   */
  async insertTablet(tablet: TableTablet): Promise<void> {
    logger.debug(`Inserting table tablet for table: ${tablet.tableName}`);

    const client = this.connection.getClient();
    const sessionId = this.connection.getSessionId();

    // Validate timestamps and convert to BigInt
    const bigIntTimestamps = tablet.timestamps.map((t) => {
      if (typeof t !== "number" || !Number.isFinite(t)) {
        throw new Error(`Invalid timestamp: ${t}`);
      }
      return BigInt(Math.floor(t));
    });

    // Serialize timestamps in big-endian format
    const timestampBuffer = Buffer.alloc(bigIntTimestamps.length * 8);
    bigIntTimestamps.forEach((ts, i) => {
      timestampBuffer.writeBigInt64BE(ts, i * 8);
    });

    // For table model, extract measurements (non-TAG and non-TIME columns)
    const measurements: string[] = [];
    const measurementTypes: number[] = [];
    
    tablet.columnNames.forEach((name, i) => {
      const category = tablet.columnCategories[i];
      // Include FIELD and ATTRIBUTE columns as measurements
      if (category === ColumnCategory.FIELD || category === ColumnCategory.ATTRIBUTE) {
        measurements.push(name);
        measurementTypes.push(tablet.columnTypes[i]);
      }
    });

    const req = new ttypes.TSInsertTabletReq({
      sessionId: sessionId,
      prefixPath: tablet.tableName,
      measurements: measurements,
      values: this.serializeTabletValues(
        tablet.values,
        tablet.columnTypes,
        tablet.timestamps.length,
      ),
      timestamps: timestampBuffer,
      types: tablet.columnTypes,
      size: tablet.timestamps.length,
      isAligned: false,
    });

    return new Promise((resolve, reject) => {
      client.insertTablet(req, (err: Error, response: any) => {
        if (err) {
          reject(err);
          return;
        }

        if (response.code !== 200) {
          reject(new Error(response.message || "Insert table tablet failed"));
          return;
        }

        resolve();
      });
    });
  }
}

export type { TableTablet, ColumnCategory } from './Session';
