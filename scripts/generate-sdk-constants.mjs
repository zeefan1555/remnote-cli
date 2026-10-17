import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import prettier from 'prettier';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const sdk = dirname(require.resolve('@remnote/plugin-sdk/package.json'));
const path = resolve(root, 'src/business/sdk-constants.generated.ts');
const source = ts.createSourceFile(
  'interfaces.d.ts',
  readFileSync(resolve(sdk, 'dist/interfaces.d.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
const names = new Set(['RemType', 'BuiltInPowerupCodes']);
const declarations = source.statements.filter(
  (node) => ts.isEnumDeclaration(node) && names.has(node.name.text)
);
if (declarations.length !== names.size) throw new Error('Official SDK enum declarations changed');

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    return node.text;
  throw new Error('Unsupported SDK property name');
}

function declaredSlotNames(file) {
  let literal;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'PowerupSlotCodeMap' &&
      node.type &&
      ts.isTypeLiteralNode(node.type)
    )
      literal = node.type;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!literal) throw new Error('PowerupSlotCodeMap declaration missing');
  const declared = new Map();
  for (const member of literal.members) {
    if (!ts.isPropertySignature(member) || !member.name) throw new Error('Malformed slot map');
    const slots = [];
    if (!member.type || !ts.isTypeLiteralNode(member.type))
      throw new Error('Malformed slot map entry');
    for (const slot of member.type.members) {
      if (!ts.isPropertySignature(slot) || !slot.name) throw new Error('Malformed slot name');
      slots.push(propertyName(slot.name));
    }
    declared.set(propertyName(member.name), slots.sort());
  }
  return declared;
}

function runtimeSlotMap(bundle) {
  const marker = 'sp:{Query:"q",Filter:"f"';
  const at = bundle.indexOf(marker);
  if (at < 0) throw new Error('SDK bundle is missing built-in powerup slot codes');
  const start = bundle.lastIndexOf('={', at);
  if (start < 0) throw new Error('SDK bundle slot map start missing');
  let depth = 0;
  let end = start + 1;
  for (; end < bundle.length; end += 1) {
    if (bundle[end] === '{') depth += 1;
    else if (bundle[end] === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  const json = bundle.slice(start + 1, end).replace(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '"$1":');
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SDK bundle slot map did not parse');
  return value;
}

const declaredSlots = declaredSlotNames(source);
const slotMap = runtimeSlotMap(readFileSync(resolve(sdk, 'dist/index.js'), 'utf8'));
const declaredKeys = [...declaredSlots.keys()].sort();
const runtimeKeys = Object.keys(slotMap).sort();
if (declaredKeys.join('\n') !== runtimeKeys.join('\n'))
  throw new Error('PowerupSlotCodeMap keys diverged from the SDK declarations');
for (const key of declaredKeys) {
  const namesForPowerup = Object.keys(slotMap[key]).sort();
  if (namesForPowerup.join('\n') !== declaredSlots.get(key).join('\n'))
    throw new Error(`Powerup slot names diverged for ${key}`);
  for (const name of namesForPowerup)
    if (typeof slotMap[key][name] !== 'string' || !slotMap[key][name])
      throw new Error(`Powerup slot code missing for ${key}.${name}`);
}

const output = await prettier.format(
  '// Generated from official SDK declarations and the SDK bundle slot-code table. Do not import the browser SDK into Node.\n' +
    declarations
      .map((node) => {
        let last = -1;
        const entries = node.members.map((member) => {
          const init = member.initializer;
          let value;
          if (!init) value = ++last;
          else if (ts.isStringLiteral(init)) value = init.text;
          else if (ts.isNumericLiteral(init)) value = last = Number(init.text);
          else throw new Error('Unsupported SDK enum initializer');
          if (node.name.text === 'RemType' && member.name.getText(source) === 'DEFAULT_TYPE') {
            // SDK 0.0.46 emits `void 0` here but loses that initializer in its declarations.
            if (JSON.parse(readFileSync(resolve(sdk, 'package.json'), 'utf8')).version !== '0.0.46')
              throw new Error('Recheck the default Rem type against the upgraded SDK runtime');
            value = undefined;
          }
          return `${member.name.getText(source)}: ${value === undefined ? 'undefined' : JSON.stringify(value)}`;
        });
        const name = node.name.text;
        const cast = name === 'RemType' ? 'unknown as ' : '';
        return `export const ${name} = {${entries.join(',')}} as ${cast}typeof import('@remnote/plugin-sdk').${name};\nexport type ${name} = import('@remnote/plugin-sdk').${name};`;
      })
      .join('\n') +
    `\nexport const PowerupSlotCodeMap = ${JSON.stringify(slotMap)} as typeof import('@remnote/plugin-sdk').PowerupSlotCodeMap;\n`,
  { ...(await prettier.resolveConfig(path)), parser: 'typescript' }
);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw new Error('SDK constants are stale');
} else writeFileSync(path, output);
import process from 'node:process';
