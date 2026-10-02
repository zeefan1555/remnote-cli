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
const output = await prettier.format(
  '// Generated from official SDK declarations. Do not import the browser SDK into Node.\n' +
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
      .join('\n'),
  { ...(await prettier.resolveConfig(path)), parser: 'typescript' }
);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw new Error('SDK constants are stale');
} else writeFileSync(path, output);
import process from 'node:process';
