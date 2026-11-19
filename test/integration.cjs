const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const root = path.resolve(__dirname, '..');
const resultPath = path.join(root, '.vscode-test', 'integration-result.json');
const result = { vscode: vscode.version, started: new Date().toISOString(), checks: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function save() {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
}

async function inspect(file, method, label, timeout = 90000) {
  const entry = { label, file, method, status: 'running' };
  result.checks.push(entry);
  save();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
  const lines = document.getText().split(/\r?\n/);
  const line = lines.findIndex(text => new RegExp(`\\b${method}\\s*\\([^;]*\\)\\s*(?::[^=]+)?\\s*\\{`).test(text));
  assert.notEqual(line, -1, `Declaration ${method} not found`);
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
      entry.symbolShape = symbols?.map(symbol => ({
        name: symbol.name, location: !!symbol.location, selectionRange: !!symbol.selectionRange,
        children: symbol.children?.length ?? 0
      }));
      const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri, 200);
      const own = (lenses || []).filter(lens => lens.command?.command === 'editor.action.showReferences'
        && lens.command.arguments?.[0]?.toString() === document.uri.toString());
      entry.lensCount = own.length;
      const target = own.find(lens => lens.range.start.line === line);
      if (target && target.command.arguments[2].length > 0) {
        entry.status = 'passed';
        entry.title = target.command.title;
        entry.referenceLocations = target.command.arguments[2].map(location => ({
          file: location.uri.fsPath, line: location.range.start.line + 1
        }));
        entry.elapsedMs = Date.now() - started;
        save();
        return;
      }
    } catch (error) { lastError = String(error); }
    entry.lastError = lastError;
    entry.elapsedMs = Date.now() - started;
    save();
    await sleep(2000);
  }
  entry.status = 'failed';
  save();
  throw new Error(`${label}: no references CodeLens for ${method}; ${lastError || JSON.stringify(entry)}`);
}

exports.run = async () => {
  try {
    const extension = vscode.extensions.getExtension('local-dev.reflens');
    assert(extension, 'Development extension is not available');
    await extension.activate();
    result.extensionPath = extension.extensionPath;
    result.extensions = ['redhat.java', 'Angular.ng-template', 'bmewburn.vscode-intelephense-client', 'vscode.typescript-language-features']
      .map(id => ({ id, installed: !!vscode.extensions.getExtension(id) }));
    save();
    await inspect(path.join(__dirname, 'fixtures/typescript/component.ts'), 'load', 'TypeScript decorated class, nested method');
    if (process.env.VS_REFERENCES_ANGULAR_WORKSPACE && process.env.VS_REFERENCES_ANGULAR_FILE) {
      await inspect(
        path.resolve(process.env.VS_REFERENCES_ANGULAR_WORKSPACE, process.env.VS_REFERENCES_ANGULAR_FILE),
        process.env.VS_REFERENCES_ANGULAR_METHOD || 'load',
        'Actual Angular component'
      );
    } else {
      result.checks.push({ label: 'Actual Angular component', status: 'skipped',
        reason: 'Set VS_REFERENCES_ANGULAR_WORKSPACE and VS_REFERENCES_ANGULAR_FILE for a real project.' });
    }
    await inspect(path.join(__dirname, 'fixtures/java/ReferenceSample.java'), 'greeting', 'Java language server');
    await inspect(path.join(__dirname, 'fixtures/php/ReferenceSample.php'), 'greeting', 'PHP Intelephense');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error.stack || String(error);
    throw error;
  } finally {
    result.finished = new Date().toISOString();
    save();
  }
};
