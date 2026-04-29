const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, 'schema.prisma');
let schema = fs.readFileSync(schemaPath, 'utf8');

function toSnakeCase(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

const lines = schema.split('\n');
const newLines = [];
let inModel = false;
let modelName = '';

for (let i = 0; i < lines.length; i++) {
  let line = lines[i];
  
  const modelMatch = line.match(/^model\s+([A-Za-z0-9_]+)\s*\{/);
  if (modelMatch) {
    inModel = true;
    modelName = modelMatch[1];
    newLines.push(line);
    continue;
  }
  
  if (inModel && line.trim() === '}') {
    const snakeModelName = toSnakeCase(modelName).replace(/^_/, '');
    newLines.push(`  @@map("${snakeModelName}")`);
    newLines.push(line);
    inModel = false;
    continue;
  }
  
  if (inModel) {
    // Check if it's a field definition
    // Not a relation field, not a comment, not a block attribute
    const isComment = line.trim().startsWith('//');
    const isBlockAttribute = line.trim().startsWith('@@');
    const fieldMatch = line.match(/^\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)(\[\]|\?)?(\s+.*)?$/);
    
    if (!isComment && !isBlockAttribute && fieldMatch) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];
      
      // Exclude relation fields (types that are our models/enums and not primitive)
      // Actually, if it has @relation, we can check.
      const hasRelation = line.includes('@relation');
      const isPrimitive = ['String', 'Boolean', 'Int', 'Float', 'DateTime', 'Json'].includes(fieldType);
      const isEnum = ['NodeType', 'EventType', 'Status', 'OnboardingStatus', 'OnboardedType'].includes(fieldType);
      
      if (!hasRelation && (isPrimitive || isEnum)) {
        const snakeFieldName = toSnakeCase(fieldName);
        if (fieldName !== snakeFieldName) {
          // Check if @map is already present
          if (!line.includes('@map')) {
            line = line + ` @map("${snakeFieldName}")`;
          }
        }
      }
    }
  }
  
  newLines.push(line);
}

fs.writeFileSync(schemaPath, newLines.join('\n'));
console.log('Schema updated.');
