#!/usr/bin/env node

/**
 * Simple connection test to verify IoTDB credentials
 */

const { Session } = require('../dist/index.js');

const IOTDB_HOST = process.env.IOTDB_HOST || '192.168.99.28';
const IOTDB_PORT = parseInt(process.env.IOTDB_PORT || '6667');
const IOTDB_USER = process.env.IOTDB_USER || 'root';
const IOTDB_PASSWORD = process.env.IOTDB_PASSWORD || 'TimechoDB@2021';

async function testConnection() {
  console.log('Testing connection to IoTDB...');
  console.log(`Host: ${IOTDB_HOST}:${IOTDB_PORT}`);
  console.log(`User: ${IOTDB_USER}`);
  console.log(`Password: ${'*'.repeat(IOTDB_PASSWORD.length)}`);
  
  const session = new Session({
    host: IOTDB_HOST,
    port: IOTDB_PORT,
    username: IOTDB_USER,
    password: IOTDB_PASSWORD,
  });
  
  try {
    await session.open();
    console.log('✅ Connection successful!');
    
    // Test a simple query
    const dataSet = await session.executeQueryStatement('SHOW DATABASES');
    console.log('✅ Query successful!');
    
    const rows = await dataSet.toArray();
    console.log(`Found ${rows.length} databases`);
    
    await dataSet.close();
    await session.close();
    
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testConnection();
