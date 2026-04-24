import fs from 'fs';

const content = fs.readFileSync('prisma/schema.prisma', 'utf8');

function toCamelCase(str) {
  return str.replace(/_([a-z0-9])/g, (g) => g[1].toUpperCase());
}

const lines = content.split('\n');
const newLines = lines.map(line => {
  // Match fields: name type ...
  // Ignore model names, enum names, relations, etc.
  // A field line usually looks like:   name       Type   @...
  const match = line.match(/^(\s+)([a-z][a-z0-9_]*)(\s+)([A-Z][A-Za-z0-9]*(\[\])?\??)(\s+.*)?$/);
  if (match) {
    const [_, indent, name, space1, type, arrayOrOpt, rest] = match;
    if (name.includes('_') || name === 'isactive' || name === 'isglobalAccess' || name === 'nodepath' || name === 'nodename' || name === 'nodetype') {
      let newName = toCamelCase(name);
      if (name === 'isactive') newName = 'isActive';
      if (name === 'isglobalAccess') newName = 'isGlobalAccess';
      if (name === 'nodepath') newName = 'nodePath';
      if (name === 'nodename') newName = 'nodeName';
      if (name === 'nodetype') newName = 'nodeType';
      
      let newLine = `${indent}${newName}${space1}${type}`;
      if (rest) {
        if (!rest.includes('@map')) {
           newLine += ` ${rest.trim()} @map("${name}")`;
        } else {
           newLine += ` ${rest.trim()}`;
        }
      } else {
        newLine += ` @map("${name}")`;
      }
      return newLine;
    }
  }
  return line;
});

fs.writeFileSync('prisma/schema.prisma.new', newLines.join('\n'));
console.log('Done');
