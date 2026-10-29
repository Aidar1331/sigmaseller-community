const fs = require('fs');
const path = require('path');
const output = path.resolve('.next/standalone');
if (!fs.existsSync(path.join(output, 'server.js'))) throw new Error('Standalone server missing');
fs.cpSync('.next/static', path.join(output, '.next/static'), { recursive: true });
if (fs.existsSync('public')) fs.cpSync('public', path.join(output, 'public'), { recursive: true });
