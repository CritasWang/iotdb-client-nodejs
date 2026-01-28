#!/usr/bin/env node

/**
 * Post-process generated Thrift TypeScript files to add missing Int64 import
 * This is a workaround for @creditkarma/thrift-typescript not including the Int64 import
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const THRIFT_DIR = path.join(__dirname, '../src/thrift/generated');

// Find all TypeScript files in the generated directory
const files = glob.sync(`${THRIFT_DIR}/**/*.ts`);

let fixedCount = 0;

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  
  // Check if file uses Int64 but doesn't import it
  if (content.includes('Int64') && !content.includes('import Int64')) {
    // Find the position after the last import statement
    const importRegex = /import[^;]+;/g;
    const imports = content.match(importRegex) || [];
    
    if (imports.length > 0) {
      const lastImport = imports[imports.length - 1];
      const lastImportIndex = content.lastIndexOf(lastImport);
      const insertPos = lastImportIndex + lastImport.length;
      
      // Insert the Int64 import
      const int64Import = '\nimport Int64 = require("node-int64");';
      content = content.slice(0, insertPos) + int64Import + content.slice(insertPos);
      
      fs.writeFileSync(file, content, 'utf8');
      fixedCount++;
      console.log(`Fixed Int64 import in: ${path.relative(THRIFT_DIR, file)}`);
    }
  }
});

console.log(`\nFixed ${fixedCount} file(s)`);
