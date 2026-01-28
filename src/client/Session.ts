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

import { Connection } from '../connection/Connection';
import { Config, DEFAULT_CONFIG, parseNodeUrls, EndPoint } from '../utils/Config';
import { logger } from '../utils/Logger';
import { SessionDataSet } from './SessionDataSet';
import { RowRecord } from './RowRecord';

const ttypes = require('../thrift/generated/client_types');

/**
 * @deprecated QueryResult is deprecated. Use SessionDataSet instead.
 */
export interface QueryResult {
  columns: string[];
  dataTypes: string[];
  rows: any[][];
  queryId?: number;
}

export { SessionDataSet, RowRecord };

export interface Tablet {
  deviceId: string;
  measurements: string[];
  dataTypes: number[];
  timestamps: number[];
  values: any[][];
}

export class Session {
  protected config: Config;
  protected connection: Connection;

  constructor(config: Config) {
    // Validate config - either host/port or nodeUrls must be provided
    if (!config.host && !config.nodeUrls) {
      throw new Error('Either host/port or nodeUrls must be provided');
    }
    
    if (config.host && !config.port) {
      throw new Error('Port is required when host is provided');
    }

    if (config.nodeUrls && config.nodeUrls.length === 0) {
      throw new Error('nodeUrls array cannot be empty');
    }

    // If nodeUrls is provided, parse and use the first node for single session
    if (config.nodeUrls && config.nodeUrls.length > 0) {
      // Parse nodeUrls if in string format
      const endpoints: EndPoint[] = typeof config.nodeUrls[0] === 'string'
        ? parseNodeUrls(config.nodeUrls as string[])
        : config.nodeUrls as EndPoint[];
      
      const firstNode = endpoints[0];
      this.config = { ...DEFAULT_CONFIG, ...config, host: firstNode.host, port: firstNode.port } as Config;
    } else {
      this.config = { ...DEFAULT_CONFIG, ...config } as Config;
    }
    
    this.connection = new Connection(this.config);
  }

  async open(): Promise<void> {
    await this.connection.open();
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  /**
   * Execute a query and return a SessionDataSet for iterating through results.
   * This method supports lazy loading and proper resource management.
   * 
   * @param sql SQL query statement
   * @param timeoutMs Query timeout in milliseconds (default: 60000)
   * @returns SessionDataSet for iterating through query results
   * 
   * @example
   * ```typescript
   * const dataSet = await session.executeQueryStatement('SELECT * FROM root.test');
   * while (await dataSet.hasNext()) {
   *   const row = dataSet.next();
   *   console.log(row.getTimestamp(), row.getFields());
   * }
   * await dataSet.close();
   * ```
   */
  async executeQueryStatement(sql: string, timeoutMs: number = 60000): Promise<SessionDataSet> {
    logger.debug(`Executing query: ${sql}`);

    const client = this.connection.getClient();
    const sessionId = this.connection.getSessionId();
    const statementId = this.connection.getStatementId();

    const req = new ttypes.TSExecuteStatementReq({
      sessionId: sessionId,
      statement: sql,
      statementId: statementId,
      fetchSize: this.config.fetchSize || 1024,
      timeout: timeoutMs,
      enableRedirectQuery: true,
      jdbcQuery: true,
    });

    return new Promise((resolve, reject) => {
      client.executeQueryStatementV2(req, async (err: Error, response: any) => {
        if (err) {
          reject(err);
          return;
        }

        if (response.status.code !== 200) {
          reject(new Error(response.status.message || 'Query failed'));
          return;
        }

        try {
          let initialRows: any[][];
          const ignoreTimeStamp = response.ignoreTimeStamp || false;
          
          // Handle both queryDataSet and queryResult formats
          if (response.queryResult && response.queryResult.length > 0) {
            // New TsBlock format (queryResult is Buffer[])
            initialRows = await this.parseQueryResult(
              response.queryResult,
              response.columns?.length || 0,
              response.dataTypeList || [],
              ignoreTimeStamp
            );
          } else if (response.queryDataSet) {
            // Old columnar format (TSQueryDataSet)
            initialRows = await this.parseDataSet(
              response.queryDataSet,
              response.columns?.length || 0,
              response.dataTypeList || []
            );
          } else {
            // No data in response
            initialRows = [];
          }

          // Create SessionDataSet
          const dataSet = new SessionDataSet(
            this,
            response.queryId,
            statementId,
            sql,
            response.columns || [],
            response.dataTypeList || [],
            initialRows,
            response.moreData || false,
            this.config.fetchSize || 1024,
            sessionId,
            ignoreTimeStamp
          );

          resolve(dataSet);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
  }

  async executeNonQueryStatement(sql: string): Promise<void> {
    logger.debug(`Executing non-query: ${sql}`);

    const client = this.connection.getClient();
    const sessionId = this.connection.getSessionId();
    const statementId = this.connection.getStatementId();

    const req = new ttypes.TSExecuteStatementReq({
      sessionId: sessionId,
      statement: sql,
      statementId: statementId,
    });

    return new Promise((resolve, reject) => {
      client.executeUpdateStatementV2(req, (err: Error, response: any) => {
        if (err) {
          reject(err);
          return;
        }

        if (response.status.code !== 200) {
          reject(new Error(response.status.message || 'Statement execution failed'));
          return;
        }

        resolve();
      });
    });
  }

  async insertTablet(tablet: Tablet): Promise<void> {
    logger.debug(`Inserting tablet for device: ${tablet.deviceId}`);

    const client = this.connection.getClient();
    const sessionId = this.connection.getSessionId();

    // Validate timestamps and convert to BigInt
    const bigIntTimestamps = tablet.timestamps.map(t => {
      if (typeof t !== 'number' || !Number.isFinite(t)) {
        throw new Error(`Invalid timestamp: ${t}`);
      }
      return BigInt(Math.floor(t));
    });

    const req = new ttypes.TSInsertTabletReq({
      sessionId: sessionId,
      prefixPath: tablet.deviceId,
      measurements: tablet.measurements,
      values: this.serializeTabletValues(tablet),
      timestamps: Buffer.from(new BigInt64Array(bigIntTimestamps).buffer),
      types: tablet.dataTypes,
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
          reject(new Error(response.message || 'Insert tablet failed'));
          return;
        }

        resolve();
      });
    });
  }

  private serializeTabletValues(tablet: Tablet): Buffer {
    // Serialize tablet values based on data types
    // Format: all columns data, then bitmap for null values
    const buffers: Buffer[] = [];
    const bitMaps: (boolean[] | null)[] = [];

    // Serialize each column
    for (let colIndex = 0; colIndex < tablet.measurements.length; colIndex++) {
      const dataType = tablet.dataTypes[colIndex];
      const columnValues = tablet.values.map((row) => row[colIndex]);

      // Track null values for this column
      const nullBitmap: boolean[] = [];
      let hasNull = false;
      
      for (let rowIndex = 0; rowIndex < columnValues.length; rowIndex++) {
        const isNull = columnValues[rowIndex] === null || columnValues[rowIndex] === undefined;
        nullBitmap.push(isNull);
        if (isNull) {
          hasNull = true;
        }
      }

      const buffer = this.serializeColumn(columnValues, dataType);
      buffers.push(buffer);
      bitMaps.push(hasNull ? nullBitmap : null);
    }

    // Append bitmap information
    const bitmapBuffer = this.serializeBitMaps(bitMaps, tablet.timestamps.length);
    buffers.push(bitmapBuffer);

    return Buffer.concat(buffers);
  }

  private serializeColumn(values: any[], dataType: number): Buffer {
    // TSDataType from Apache TSFile:
    // BOOLEAN(0), INT32(1), INT64(2), FLOAT(3), DOUBLE(4), TEXT(5),
    // VECTOR(6), UNKNOWN(7), TIMESTAMP(8), DATE(9), BLOB(10), STRING(11), OBJECT(12)
    switch (dataType) {
      case 0: // BOOLEAN
        return Buffer.from(values.map((v) => (v === null || v === undefined) ? 0 : (v ? 1 : 0)));
      case 1: // INT32
        return Buffer.from(new Int32Array(values.map(v => (v === null || v === undefined) ? 0 : v)).buffer);
      case 2: // INT64
        return Buffer.from(new BigInt64Array(values.map(v => (v === null || v === undefined) ? BigInt(0) : BigInt(v))).buffer);
      case 3: { // FLOAT
        return Buffer.from(new Float32Array(values.map(v => (v === null || v === undefined) ? 0.0 : v)).buffer);
      }
      case 4: { // DOUBLE
        return Buffer.from(new Float64Array(values.map(v => (v === null || v === undefined) ? 0.0 : v)).buffer);
      }
      case 5: // TEXT
      case 11: { // STRING (similar to TEXT)
        const strBuffers = values.map((v) => {
          const str = (v === null || v === undefined) ? '' : String(v);
          const strBytes = Buffer.from(str, 'utf8');
          const len = Buffer.alloc(4);
          len.writeInt32BE(strBytes.length); // Write byte length in big-endian (Java standard)
          return Buffer.concat([len, strBytes]);
        });
        return Buffer.concat(strBuffers);
      }
      case 8: { // TIMESTAMP (stored as INT64 - milliseconds)
        return Buffer.from(new BigInt64Array(values.map(v => {
          if (v === null || v === undefined) {
            return BigInt(0);
          }
          if (v instanceof Date) {
            return BigInt(v.getTime());
          }
          return BigInt(v);
        })).buffer);
      }
      case 9: { // DATE (stored as INT32 - days since epoch)
        return Buffer.from(new Int32Array(values.map(v => {
          if (v === null || v === undefined) {
            return 0;
          }
          if (v instanceof Date) {
            return Math.floor(v.getTime() / (24 * 60 * 60 * 1000));
          }
          return v;
        })).buffer);
      }
      case 10: { // BLOB
        const blobBuffers = values.map((v) => {
          const blob = (v === null || v === undefined) ? Buffer.alloc(0) : (Buffer.isBuffer(v) ? v : Buffer.from(v));
          const len = Buffer.alloc(4);
          len.writeInt32BE(blob.length); // Write byte length in big-endian (Java standard)
          return Buffer.concat([len, blob]);
        });
        return Buffer.concat(blobBuffers);
      }
      default:
        throw new Error(`Unsupported data type: ${dataType}`);
    }
  }

  private serializeBitMaps(bitMaps: (boolean[] | null)[], rowCount: number): Buffer {
    // Serialize bitmap information for null values
    // Format: for each column, one byte indicating if column has null, followed by bitmap bytes if it does
    const buffers: Buffer[] = [];
    
    for (const bitMap of bitMaps) {
      const columnHasNull = bitMap !== null;
      // Write one byte: 1 if column has null, 0 if not
      buffers.push(Buffer.from([columnHasNull ? 1 : 0]));
      
      if (columnHasNull && bitMap) {
        // Calculate number of bytes needed for bitmap (1 bit per row)
        // Use Math.ceil to properly round up only when needed
        const bitmapByteCount = Math.ceil(rowCount / 8);
        const bitmapBytes = Buffer.alloc(bitmapByteCount);
        
        // Set bits in bitmap (1 = null, 0 = not null)
        for (let i = 0; i < bitMap.length; i++) {
          if (bitMap[i]) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            bitmapBytes[byteIndex] |= (1 << bitIndex);
          }
        }
        
        buffers.push(bitmapBytes);
      }
    }
    
    return Buffer.concat(buffers);
  }

  /**
   * Parse queryResult (TsBlock format) - new format used by IoTDB
   * queryResult is an array of Buffers representing columnar data in TsBlock format
   * @param ignoreTimeStamp - If true, no time column is present; if false, time column is at index 0
   */
  async parseQueryResult(
    queryResult: Buffer[],
    _columnCount: number,
    dataTypes: string[],
    ignoreTimeStamp: boolean = false
  ): Promise<any[][]> {
    const rows: any[][] = [];

    if (!queryResult || queryResult.length === 0) {
      logger.debug('parseQueryResult: queryResult is null or empty');
      return rows;
    }

    logger.debug(`parseQueryResult: queryResult has ${queryResult.length} buffers, ignoreTimeStamp=${ignoreTimeStamp}`);
    logger.debug(`parseQueryResult: dataTypes: ${JSON.stringify(dataTypes)}`);

    // Determine row count and parse time column if present
    let timeBuffer: Buffer | null = null;
    let rowCount = 0;
    let valueColumnStartIndex = 0;

    if (!ignoreTimeStamp && queryResult.length > 0) {
      // First buffer is time column
      timeBuffer = Buffer.isBuffer(queryResult[0]) ? queryResult[0] : Buffer.from(queryResult[0]);
      
      // Validate time buffer
      const timeBufferLength = timeBuffer.length;
      if (timeBufferLength === 0 || timeBufferLength % 8 !== 0) {
        logger.warn('Invalid time buffer length:', timeBufferLength);
        return rows;
      }

      rowCount = Math.floor(timeBufferLength / 8);
      valueColumnStartIndex = 1; // Value columns start from index 1
    } else {
      // No time column, determine row count from first value column
      if (queryResult.length > 0) {
        const firstValueBuffer = Buffer.isBuffer(queryResult[0]) ? queryResult[0] : Buffer.from(queryResult[0]);
        // Row count depends on data type, but we need to infer it
        // For simplicity, we'll determine it from the first column based on its type
        const firstDataType = this.getDataTypeCode(dataTypes[0]);
        rowCount = this.getRowCountFromBuffer(firstValueBuffer, firstDataType);
      }
      valueColumnStartIndex = 0; // Value columns start from index 0
    }

    logger.debug(`parseQueryResult: rowCount = ${rowCount}, valueColumnStartIndex = ${valueColumnStartIndex}`);
    
    // Parse value columns
    const parsedColumns: any[][] = [];
    for (let colIndex = valueColumnStartIndex; colIndex < queryResult.length; colIndex++) {
      const valueBuffer = Buffer.isBuffer(queryResult[colIndex]) 
        ? queryResult[colIndex] 
        : Buffer.from(queryResult[colIndex]);
      
      // Get data type - dataTypes array corresponds to value columns (not including time)
      const dataTypeIndex = colIndex - valueColumnStartIndex;
      const dataType = this.getDataTypeCode(dataTypes[dataTypeIndex]);
      
      logger.debug(`parseQueryResult: column ${colIndex}, dataTypeIndex=${dataTypeIndex}, dataType = ${dataType}, valueBuffer.length = ${valueBuffer.length}`);
      
      // Note: queryResult format may not have separate bitmap, nulls may be indicated differently
      // For now, pass null bitmap and deserialize the column
      const columnValues = this.deserializeColumn(valueBuffer, dataType, rowCount, null);
      parsedColumns.push(columnValues);
    }

    // Build rows
    for (let i = 0; i < rowCount; i++) {
      const row: any[] = [];
      
      // Add timestamp if time column is present
      if (timeBuffer && timeBuffer.length >= (i * 8 + 8)) {
        row.push(timeBuffer.readBigInt64LE(i * 8));
      }
      
      // Add column values
      for (let colIndex = 0; colIndex < parsedColumns.length; colIndex++) {
        row.push(parsedColumns[colIndex][i]);
      }
      
      rows.push(row);
    }

    logger.debug(`parseQueryResult: returning ${rows.length} rows`);
    return rows;
  }

  /**
   * Helper method to convert data type string to numeric code
   */
  private getDataTypeCode(typeStr: string | undefined): number {
    if (!typeStr) return 5; // Default to TEXT
    
    const type = String(typeStr).toUpperCase();
    if (type.includes('BOOLEAN')) return 0;
    else if (type.includes('INT32')) return 1;
    else if (type.includes('INT64')) return 2;
    else if (type.includes('FLOAT')) return 3;
    else if (type.includes('DOUBLE')) return 4;
    else if (type.includes('TEXT')) return 5;
    else if (type.includes('TIMESTAMP')) return 8;
    else if (type.includes('DATE')) return 9;
    else if (type.includes('BLOB')) return 10;
    else if (type.includes('STRING')) return 11;
    return 5; // Default to TEXT
  }

  /**
   * Helper method to determine row count from a buffer based on data type
   */
  private getRowCountFromBuffer(buffer: Buffer, dataType: number): number {
    const length = buffer.length;
    
    // Calculate based on fixed-size types
    switch (dataType) {
      case 0: // BOOLEAN - 1 byte per value
        return length;
      case 1: // INT32 - 4 bytes per value
      case 9: // DATE - 4 bytes per value
        return Math.floor(length / 4);
      case 2: // INT64 - 8 bytes per value
      case 8: // TIMESTAMP - 8 bytes per value
        return Math.floor(length / 8);
      case 3: // FLOAT - 4 bytes per value
        return Math.floor(length / 4);
      case 4: // DOUBLE - 8 bytes per value
        return Math.floor(length / 8);
      case 5: // TEXT - variable length, need to parse
      case 10: // BLOB - variable length
      case 11: // STRING - variable length
        // For variable-length types, count entries by parsing length prefixes
        let count = 0;
        let offset = 0;
        while (offset + 4 <= length) {
          const strLength = buffer.readInt32BE(offset);
          offset += 4 + strLength;
          count++;
        }
        return count;
      default:
        logger.warn(`Unknown data type ${dataType}, cannot determine row count`);
        return 0;
    }
  }

  // parseDataSet is used by SessionDataSet for parsing query results
  // Keep it as public for SessionDataSet to access
  async parseDataSet(
    dataset: any,
    _columnCount: number,
    dataTypes: string[]
  ): Promise<any[][]> {
    const rows: any[][] = [];

    if (!dataset) {
      logger.debug('parseDataSet: dataset is null or undefined');
      return rows;
    }

    // Handle case where dataset.time is not a Buffer (might be an array or null)
    if (!dataset.time) {
      logger.debug('parseDataSet: dataset.time is null or undefined');
      return rows;
    }

    logger.debug(`parseDataSet: dataset.time type: ${typeof dataset.time}, isBuffer: ${Buffer.isBuffer(dataset.time)}, length: ${dataset.time.length || 'N/A'}`);
    logger.debug(`parseDataSet: dataset.valueList type: ${typeof dataset.valueList}, isArray: ${Array.isArray(dataset.valueList)}, length: ${dataset.valueList?.length || 'N/A'}`);
    logger.debug(`parseDataSet: dataTypes: ${JSON.stringify(dataTypes)}`);

    // Convert time to Buffer if it's not already
    const timeBuffer = Buffer.isBuffer(dataset.time) ? dataset.time : Buffer.from(dataset.time);
    
    // Validate buffer has sufficient length
    const timeBufferLength = timeBuffer.length;
    if (timeBufferLength === 0 || timeBufferLength % 8 !== 0) {
      logger.warn('Invalid time buffer length:', timeBufferLength);
      return rows;
    }

    const rowCount = Math.floor(timeBufferLength / 8);
    logger.debug(`parseDataSet: rowCount = ${rowCount}`);
    
    // Parse value buffers
    const parsedColumns: any[][] = [];
    if (dataset.valueList && Array.isArray(dataset.valueList)) {
      for (let colIndex = 0; colIndex < dataset.valueList.length; colIndex++) {
        const valueBuffer = Buffer.isBuffer(dataset.valueList[colIndex]) 
          ? dataset.valueList[colIndex] 
          : Buffer.from(dataset.valueList[colIndex]);
        const bitmap = dataset.bitmapList && dataset.bitmapList[colIndex]
          ? (Buffer.isBuffer(dataset.bitmapList[colIndex]) 
              ? dataset.bitmapList[colIndex] 
              : Buffer.from(dataset.bitmapList[colIndex]))
          : null;
        
        // Get data type - dataTypes might be an array of strings or numbers
        let dataType = 5; // Default to TEXT
        if (dataTypes && dataTypes[colIndex] !== undefined) {
          const typeStr = String(dataTypes[colIndex]).toUpperCase();
          if (typeStr.includes('BOOLEAN')) dataType = 0;
          else if (typeStr.includes('INT32')) dataType = 1;
          else if (typeStr.includes('INT64')) dataType = 2;
          else if (typeStr.includes('FLOAT')) dataType = 3;
          else if (typeStr.includes('DOUBLE')) dataType = 4;
          else if (typeStr.includes('TEXT')) dataType = 5;
          else if (typeStr.includes('TIMESTAMP')) dataType = 8;
          else if (typeStr.includes('DATE')) dataType = 9;
          else if (typeStr.includes('BLOB')) dataType = 10;
          else if (typeStr.includes('STRING')) dataType = 11;
        }
        
        logger.debug(`parseDataSet: column ${colIndex}, dataType = ${dataType}, valueBuffer.length = ${valueBuffer.length}`);
        const columnValues = this.deserializeColumn(valueBuffer, dataType, rowCount, bitmap);
        parsedColumns.push(columnValues);
      }
    }

    // Build rows
    for (let i = 0; i < rowCount; i++) {
      const row: any[] = [];
      
      // Add timestamp
      if (i * 8 + 8 <= timeBufferLength) {
        row.push(timeBuffer.readBigInt64LE(i * 8));
      }
      
      // Add column values
      for (let colIndex = 0; colIndex < parsedColumns.length; colIndex++) {
        row.push(parsedColumns[colIndex][i]);
      }
      
      rows.push(row);
    }

    logger.debug(`parseDataSet: returning ${rows.length} rows`);
    return rows;
  }

  private deserializeColumn(buffer: Buffer, dataType: number, rowCount: number, bitmap: Buffer | null): any[] {
    const values: any[] = [];
    
    try {
      switch (dataType) {
        case 0: { // BOOLEAN
          for (let i = 0; i < rowCount; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              values.push(buffer[i] !== 0);
            }
          }
          break;
        }
        case 1: { // INT32
          const int32Array = new Int32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
          for (let i = 0; i < rowCount && i < int32Array.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              values.push(int32Array[i]);
            }
          }
          break;
        }
        case 2: { // INT64
          const bigInt64Array = new BigInt64Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 8));
          for (let i = 0; i < rowCount && i < bigInt64Array.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              values.push(bigInt64Array[i]);
            }
          }
          break;
        }
        case 3: { // FLOAT
          const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
          for (let i = 0; i < rowCount && i < float32Array.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              values.push(float32Array[i]);
            }
          }
          break;
        }
        case 4: { // DOUBLE
          const float64Array = new Float64Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 8));
          for (let i = 0; i < rowCount && i < float64Array.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              values.push(float64Array[i]);
            }
          }
          break;
        }
        case 5: // TEXT
        case 11: { // STRING (similar to TEXT)
          let offset = 0;
          for (let i = 0; i < rowCount && offset < buffer.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              if (offset + 4 > buffer.length) break;
              const strLength = buffer.readInt32LE(offset);
              offset += 4;
              if (offset + strLength > buffer.length) break;
              const str = buffer.toString('utf8', offset, offset + strLength);
              values.push(str);
              offset += strLength;
            }
          }
          break;
        }
        case 8: { // TIMESTAMP (stored as INT64 - milliseconds)
          const bigInt64Array = new BigInt64Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 8));
          for (let i = 0; i < rowCount && i < bigInt64Array.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              // Convert milliseconds to Date object
              const timestamp = Number(bigInt64Array[i]);
              const date = new Date(timestamp);
              values.push(date);
            }
          }
          break;
        }
        case 9: { // DATE (stored as INT32 - days since epoch)
          const int32Array = new Int32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
          for (let i = 0; i < rowCount && i < int32Array.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              // Convert days since epoch to Date object
              const days = int32Array[i];
              const date = new Date(days * 24 * 60 * 60 * 1000);
              values.push(date);
            }
          }
          break;
        }
        case 10: { // BLOB
          let offset = 0;
          for (let i = 0; i < rowCount && offset < buffer.length; i++) {
            if (this.isNull(bitmap, i)) {
              values.push(null);
            } else {
              if (offset + 4 > buffer.length) break;
              const blobLength = buffer.readInt32LE(offset);
              offset += 4;
              if (offset + blobLength > buffer.length) break;
              const blob = buffer.slice(offset, offset + blobLength);
              values.push(blob);
              offset += blobLength;
            }
          }
          break;
        }
        default:
          // Unknown type, return nulls
          for (let i = 0; i < rowCount; i++) {
            values.push(null);
          }
      }
    } catch (error) {
      logger.error('Error deserializing column:', error);
      // Fill with nulls on error
      for (let i = values.length; i < rowCount; i++) {
        values.push(null);
      }
    }
    
    return values;
  }

  private isNull(bitmap: Buffer | null, index: number): boolean {
    if (!bitmap) return false;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    if (byteIndex >= bitmap.length) return false;
    return (bitmap[byteIndex] & (1 << bitIndex)) === 0;
  }

  isOpen(): boolean {
    return this.connection.isOpen();
  }
}
