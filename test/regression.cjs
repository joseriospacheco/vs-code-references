// Run with: node --test test/regression.cjs
// These checks execute the production provider with a small VS Code API mock.
// They do not claim to validate a language server or the installed extension.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isEqual(other) { return this.line === other.line && this.character === other.character; }
  isBefore(other) { return this.line < other.line || (this.line === other.line && this.character < other.character); }
  isBeforeOrEqual(other) { return this.isBefore(other) || this.isEqual(other); }
  compareTo(other) { return this.line - other.line || this.character - other.character; }
  translate(lineDelta = 0, characterDelta = 0) { return new Position(this.line + lineDelta, this.character + characterDelta); }
}

class Range {
  constructor(start, end, endLine, endCharacter) {
    this.start = typeof start === 'number' ? new Position(start, end) : start;
    this.end = typeof start === 'number' ? new Position(endLine, endCharacter) : end;
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  contains(value) {
    const start = value.start || value;
    const end = value.end || value;
    return this.start.isBeforeOrEqual(start) && end.isBeforeOrEqual(this.end);
  }
}

class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }

const SymbolKind = Object.fromEntries([
  'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field',
  'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String',
  'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct',
  'Event', 'Operator', 'TypeParameter'
].map((name, index) => [name, index]));

function document(text, filename = 'sample.ts') {
  const uri = {
    scheme: 'file', path: `/${filename}`, fsPath: filename,
    toString() { return `file:///${filename}`; }
  };
  const lines = text.split('\n');
  const offsetAt = position => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
  const positionAt = offset => {
    const before = text.slice(0, offset).split('\n');
    return new Position(before.length - 1, before.at(-1).length);
  };
  return {
    uri, version: 1, languageId: filename.endsWith('.java') ? 'java' : 'typescript',
    lineCount: lines.length, isClosed: false,
    offsetAt, positionAt,
    lineAt: index => ({ text: lines[index], range: new Range(index, 0, index, lines[index].length) }),
    getText: range => range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    getWordRangeAtPosition(position) {
      const text = lines[position.line];
      for (const match of text.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) {
        if (position.character >= match.index && position.character <= match.index + match[0].length) {
          return new Range(position.line, match.index, position.line, match.index + match[0].length);
        }
      }
      return undefined;
    }
  };
}

function symbol(doc, name, kind, selectionRange, range = selectionRange, children = [], hybrid = false) {
  const result = { name, detail: '', kind, range, selectionRange, children };
  // executeDocumentSymbolProvider returns VS Code's MergedInfo objects: these
  // contain BOTH a SymbolInformation location and DocumentSymbol children.
  if (hybrid) result.location = new Location(doc.uri, range);
  return result;
}

function harness(executeCommand = async () => []) {
  const vscode = {
    Position, Range, Location, CodeLens, EventEmitter, SymbolKind,
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    commands: { executeCommand }
  };
  const filename = path.join(__dirname, '..', 'src', 'extension.ts');
  // Expose private functions only in this in-memory compilation; no test-only
  // exports or dependencies are added to the distributed extension.
  const source = fs.readFileSync(filename, 'utf8') + '\nexport const __regression = { collectSymbols, provideCodeLenses };';
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const context = {
    exports: {}, require: name => name === 'vscode' ? vscode : require(name),
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, console
  };
  vm.runInNewContext(compiled, context, { filename });
  return context.exports.__regression;
}

test('hybrid symbol results retain nested methods and identifier positions', () => {
  const doc = document('export class Store {\n  load(): void {}\n}\n');
  const method = symbol(doc, 'load', SymbolKind.Method, new Range(1, 2, 1, 6), new Range(1, 0, 1, 17), [], true);
  const root = symbol(doc, 'Store', SymbolKind.Class, new Range(0, 13, 0, 18), new Range(0, 0, 2, 1), [method], true);
  const locations = [];
  harness().collectSymbols(doc, [root], locations, 150);
  assert.deepEqual(locations.map(location => `${location.range.start.line}:${location.range.start.character}`), ['0:13', '1:2']);
});

test('Angular component decorators do not remove the component or its methods', () => {
  const doc = document('@Component({})\nexport class Store {\n  load(): void {}\n}\n');
  const method = symbol(doc, 'load', SymbolKind.Method, new Range(2, 2, 2, 6), new Range(2, 0, 2, 17), [], true);
  const root = symbol(doc, 'Store', SymbolKind.Class, new Range(1, 13, 1, 18), new Range(0, 0, 3, 1), [method], true);
  const locations = [];
  harness().collectSymbols(doc, [root], locations, 150);
  assert.equal(locations.length, 2);
  assert.ok(locations.some(location => location.range.start.line === 2));
});

test('object-literal properties are ignored while class properties remain eligible', () => {
  const doc = document('class Store {\n  name = "";\n  save() { const data = { name: this.name }; }\n}\n');
  const classProperty = symbol(doc, 'name', SymbolKind.Property, new Range(1, 2, 1, 6));
  const objectProperty = symbol(doc, 'name', SymbolKind.Property, new Range(2, 25, 2, 29));
  const method = symbol(doc, 'save', SymbolKind.Method, new Range(2, 2, 2, 6), new Range(2, 2, 2, 45), [objectProperty]);
  const root = symbol(doc, 'Store', SymbolKind.Class, new Range(0, 6, 0, 11), new Range(0, 0, 3, 1), [classProperty, method]);
  const locations = [];
  harness().collectSymbols(doc, [root], locations, 150);
  assert.deepEqual(locations.map(location => location.range.start.line), [0, 1, 2]);
});

test('duplicate symbols at one source position produce only one location', () => {
  const doc = document('function foo() {}');
  const declaration = new Range(0, 9, 0, 12);
  const locations = [];
  harness().collectSymbols(doc, [
    symbol(doc, 'foo', SymbolKind.Function, declaration),
    symbol(doc, 'foo', SymbolKind.Function, declaration)
  ], locations, 150);
  assert.equal(locations.length, 1);
});

test('same-named symbols at different columns on one declaration line are consolidated', () => {
  const doc = document('class Box { Box() {} }');
  const typeStart = doc.getText().indexOf('Box');
  const constructorStart = doc.getText().indexOf('Box', typeStart + 1);
  const type = symbol(doc, 'Box', SymbolKind.Class,
    new Range(0, typeStart, 0, typeStart + 3), new Range(0, 0, 0, doc.getText().length), [
      symbol(doc, 'Box()', SymbolKind.Constructor,
        new Range(0, constructorStart, 0, constructorStart + 3),
        new Range(0, constructorStart, 0, doc.getText().length))
    ]);
  const locations = [];
  harness().collectSymbols(doc, [type], locations, 150);
  assert.equal(locations.length, 1);
});

test('namespace symbols do not get reference lenses', () => {
  const doc = document('namespace EduNet { class Store {} }');
  const classStart = doc.getText().indexOf('Store');
  const namespace = symbol(doc, 'EduNet', SymbolKind.Namespace,
    new Range(0, 10, 0, 16), new Range(0, 0, 0, doc.getText().length), [
      symbol(doc, 'Store', SymbolKind.Class,
        new Range(0, classStart, 0, classStart + 5))
    ]);
  const locations = [];
  harness().collectSymbols(doc, [namespace], locations, 150);
  assert.deepEqual(locations.map(location => location.range.start.character), [classStart]);
});

test('function parameters are excluded while local variables remain eligible', () => {
  const doc = document('function find(param: string) {\n  const local = param;\n}\n');
  const functionName = doc.getText().indexOf('find');
  const parameterName = doc.getText().indexOf('param');
  const localName = doc.lineAt(1).text.indexOf('local');
  const method = symbol(doc, 'find', SymbolKind.Function,
    new Range(0, functionName, 0, functionName + 4), new Range(0, 0, 2, 1), [
      symbol(doc, 'param', SymbolKind.Variable,
        new Range(0, parameterName, 0, parameterName + 5)),
      symbol(doc, 'local', SymbolKind.Variable,
        new Range(1, localName, 1, localName + 5))
    ]);
  const locations = [];
  harness().collectSymbols(doc, [method], locations, 150);
  assert.deepEqual(locations.map(location => location.range.start.line), [0, 1]);
});

test('Java annotations do not suppress unrelated annotated declarations', () => {
  const doc = document('@Autowired\nprivate Service service;\n', 'Store.java');
  const field = symbol(doc, 'service', SymbolKind.Field, new Range(1, 16, 1, 23), new Range(0, 0, 1, 24));
  const locations = [];
  harness().collectSymbols(doc, [field], locations, 150);
  assert.equal(locations.length, 1);
  assert.equal(locations[0].range.start.character, 16);
});

test('the requested suppression for override declarations remains in place', () => {
  for (const annotation of ['@override', '@Override']) {
    const doc = document(`${annotation}\nString toString() { return "value"; }\n`);
    const method = symbol(doc, 'toString', SymbolKind.Method, new Range(1, 7, 1, 15));
    const locations = [];
    harness().collectSymbols(doc, [method], locations, 150);
    assert.equal(locations.length, 0, annotation);
  }
});

test('HTML element symbols are skipped even when the lens range starts at indentation', () => {
  const doc = document('    <div class="container">\n      <span>label</span>\n', 'index.html');
  doc.languageId = 'html';
  const element = symbol(doc, 'div', SymbolKind.Property, new Range(0, 4, 0, 7), new Range(0, 0, 1, 25));
  const locations = [];
  harness().collectSymbols(doc, [element], locations, 150);
  assert.equal(locations.length, 0);
});

test('flat Java method signatures resolve to the identifier, not its modifiers', () => {
  const doc = document('public void foo(String arg) {}', 'Store.java');
  const flat = {
    name: 'foo(String)', kind: SymbolKind.Method,
    location: new Location(doc.uri, new Range(0, 0, 0, 30))
  };
  const locations = [];
  harness().collectSymbols(doc, [flat], locations, 150);
  assert.equal(locations.length, 1);
  assert.equal(locations[0].range.start.character, 12);
});

test('a symbol in another URI never reads its ranges from the current document', () => {
  const doc = document('class Local {}');
  const other = document('class External {}', 'External.java');
  doc.getText = () => { throw new Error('An external range was read against the current document'); };
  const flat = {
    name: 'External', kind: SymbolKind.Class,
    location: new Location(other.uri, new Range(100, 0, 101, 0))
  };
  const locations = [];
  harness().collectSymbols(doc, [flat], locations, 150);
  assert.equal(locations.length, 0);
});

test('counts and click locations both exclude declarations, with results in source order', async () => {
  const doc = document('function foo() {}\nfunction bar() { foo(); }\nbar();\n');
  const fooDeclaration = new Location(doc.uri, new Range(0, 9, 0, 12));
  const barDeclaration = new Location(doc.uri, new Range(1, 9, 1, 12));
  const fooUsage = new Location(doc.uri, new Range(1, 17, 1, 20));
  const barUsage = new Location(doc.uri, new Range(2, 0, 2, 3));
  const api = harness(async (command, _uri, position) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      // Intentionally reverse these to check the final source ordering.
      return [
        symbol(doc, 'bar', SymbolKind.Function, barDeclaration.range),
        symbol(doc, 'foo', SymbolKind.Function, fooDeclaration.range)
      ];
    }
    return position.line === 0 ? [fooDeclaration, fooUsage] : [barDeclaration, barUsage];
  });
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const lenses = await api.provideCodeLenses(doc, token);
  assert.equal(lenses.length, 2);
  for (const [index, expectedUsage] of [fooUsage, barUsage].entries()) {
    assert.equal(lenses[index].range.start.line, index);
    assert.equal(lenses[index].command.title, '1 reference');
    assert.equal(lenses[index].command.command, 'editor.action.showReferences');
    assert.equal(lenses[index].command.arguments[2].length, 1);
    assert.equal(lenses[index].command.arguments[2][0], expectedUsage);
  }
});

test('requests for another document cannot discard a successful CodeLens result', async () => {
  const pending = new Map();
  const docs = [document('function foo() {}', 'A.ts'), document('function foo() {}', 'B.ts')];
  const byUri = new Map(docs.map(doc => [doc.uri.toString(), doc]));
  const api = harness(async (command, uri) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      return [symbol(byUri.get(uri.toString()), 'foo', SymbolKind.Function, new Range(0, 9, 0, 12))];
    }
    if (command === 'vscode.executeReferenceProvider') {
      return await new Promise(resolve => pending.set(uri.toString(), resolve));
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const a = api.provideCodeLenses(docs[0], token);
  const b = api.provideCodeLenses(docs[1], token);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 2);
  pending.get(docs[1].uri.toString())([]);
  assert.equal((await b).length, 1);
  pending.get(docs[0].uri.toString())([]);
  assert.equal((await a).length, 1);
});

test('an edit during reference lookup discards results for the old document version', async () => {
  const doc = document('function foo() {}');
  let completeReferences;
  const api = harness(async command => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      return [symbol(doc, 'foo', SymbolKind.Function, new Range(0, 9, 0, 12))];
    }
    return await new Promise(resolve => { completeReferences = resolve; });
  });
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const request = api.provideCodeLenses(doc, token);
  await new Promise(resolve => setImmediate(resolve));
  doc.version++;
  completeReferences([]);
  assert.equal((await request).length, 0);
});
