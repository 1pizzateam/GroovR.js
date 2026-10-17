import fs from 'node:fs';

const mail = 'https://github.com/1pizzateam/GroovR.js';
const CRLF = '\r\n';
const dest = './dist/';
const license = fs.readFileSync('./LICENSE');
const header = `/*${CRLF}${license}${CRLF}${mail}${CRLF}*/${CRLF}${CRLF}`;

const files = [
  ['./build/groovr.mjs', `${dest}groovr.js`],
  ['./build/groovr.d.mts', `${dest}groovr.d.ts`],
];

fs.mkdirSync(dest, { recursive: true });
for (const [src, out] of files)
  fs.writeFileSync(out, header + fs.readFileSync(src));
