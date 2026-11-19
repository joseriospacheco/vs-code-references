import * as vscode from 'vscode';

const output = vscode.window.createOutputChannel('VS Code References');
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const lensesChanged = new vscode.EventEmitter<void>();
const delayedRefreshTimers = new Set<ReturnType<typeof setTimeout>>();

export function activate(context: vscode.ExtensionContext): void {
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensesChanged.event,
    provideCodeLenses: provideCodeLenses
  };

  context.subscriptions.push(
    output,
    lensesChanged,
    vscode.commands.registerCommand('vscodeReferences.refresh', scheduleRefresh),
    vscode.commands.registerCommand('vscodeReferences.diagnose', diagnoseActiveFile),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.window.onDidChangeActiveTextEditor(refreshForLanguageServer),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vscodeReferences')) {
        scheduleRefresh();
      }
    })
  );

  if (vscode.window.activeTextEditor) refreshForLanguageServer();
}

async function diagnoseActiveFile(): Promise<void> {
  output.show(true);
  output.appendLine('VS Code References 0.0.1 | build: symbol-tree-fix');
  const document = vscode.window.activeTextEditor?.document;
  if (!document) {
    output.appendLine('Open a source file first.');
    return;
  }
  const scope = { uri: document.uri, languageId: document.languageId };
  output.appendLine(`Language: ${document.languageId}; scheme: ${document.uri.scheme}`);
  output.appendLine(`editor.codeLens: ${vscode.workspace.getConfiguration('editor', scope).get('codeLens')}`);
  const config = vscode.workspace.getConfiguration('vscodeReferences', scope);
  output.appendLine(`Enabled: ${config.get('enabled')}; languages: ${JSON.stringify(config.get('languages'))}`);
  if (document.languageId === 'java') {
    const java = vscode.extensions.getExtension('redhat.java');
    output.appendLine(`Java language support: ${java ? `installed; active: ${java.isActive}` : 'not installed (redhat.java)'}`);
  }
  try {
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider', document.uri
    );
    const locations: vscode.Location[] = [];
    collectSymbols(document, symbols ?? [], locations, config.get('maxSymbolsPerFile', 150));
    output.appendLine(`Root symbols: ${symbols?.length ?? 0}; reference targets: ${locations.length}`);
    for (const location of locations.slice(0, 3)) {
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', document.uri, location.range.start
      );
      output.appendLine(`Line ${location.range.start.line + 1}: ${refs?.length ?? 0} locations returned by the language provider`);
    }
    if (!locations.length) output.appendLine('No eligible symbols yet. Check the language extension and project loading status.');
  } catch (error) {
    output.appendLine(`Diagnostic failed: ${String(error)}`);
  }
}

function refreshForLanguageServer(): void {
  for (const timer of delayedRefreshTimers) clearTimeout(timer);
  delayedRefreshTimers.clear();
  scheduleRefresh();

  // Project language servers can take several seconds to initialize or import
  // the workspace. Re-request CodeLens while Java/TypeScript providers start.
  for (const delay of [1000, 3000, 8000, 15000]) {
    const timer = setTimeout(() => {
      delayedRefreshTimers.delete(timer);
      lensesChanged.fire();
    }, delay);
    delayedRefreshTimers.add(timer);
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    lensesChanged.fire();
  }, 250);
}

async function provideCodeLenses(
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): Promise<vscode.CodeLens[]> {
  const documentVersion = document.version;
  const config = vscode.workspace.getConfiguration('vscodeReferences', document.uri);
  if (!config.get<boolean>('enabled', true)) return [];

  const allowedLanguages = config.get<string[]>('languages', []);
  if (allowedLanguages.length > 0 && !allowedLanguages.includes(document.languageId)) return [];

  const maxSymbols = config.get<number>('maxSymbolsPerFile', 150);
  let symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined;
  try {
    symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider', document.uri
    );
  } catch (error) {
    output.appendLine(`Could not read symbols (${document.languageId}): ${String(error)}`);
    return [];
  }
  if (!symbols?.length || token.isCancellationRequested) return [];

  const locations: vscode.Location[] = [];
  collectSymbols(document, symbols, locations, maxSymbols);
  const lenses: vscode.CodeLens[] = [];
  const includeDeclaration = config.get<boolean>('includeDeclaration', false);

  await mapWithConcurrency(locations, 6, async location => {
    if (token.isCancellationRequested) return;
    try {
      const references = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', location.uri, location.range.start
      );
      if (!references || token.isCancellationRequested) return;

      const displayedReferences = filterReferences(references, location, includeDeclaration);
      const count = displayedReferences.length;
      const lens = new vscode.CodeLens(location.range);
      lens.command = {
        title: `${count} ${count === 1 ? 'reference' : 'references'}`,
        command: 'editor.action.showReferences',
        arguments: [location.uri, location.range.start, displayedReferences]
      };
      lenses.push(lens);
    } catch (error) {
      output.appendLine(`Could not resolve references at ${location.uri.fsPath}:${location.range.start.line + 1}: ${String(error)}`);
    }
  });

  if (token.isCancellationRequested || document.version !== documentVersion) return [];
  return lenses.sort((a, b) => a.range.start.compareTo(b.range.start));
}

function collectSymbols(
  document: vscode.TextDocument,
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  locations: vscode.Location[],
  limit: number
): void {
  const seen = new Set<string>();
  collectSymbolsInto(document, symbols, locations, limit, seen);
}

function collectSymbolsInto(
  document: vscode.TextDocument,
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  locations: vscode.Location[],
  limit: number,
  seen: Set<string>,
  parentKind?: vscode.SymbolKind
): void {
  for (const entry of symbols) {
    if (locations.length >= limit) return;
    // executeDocumentSymbolProvider returns hybrid objects in VS Code:
    // location, selectionRange AND children can all be present together.
    const uri = 'location' in entry ? entry.location.uri : document.uri;
    if (uri.toString() !== document.uri.toString()) continue;
    const range = 'selectionRange' in entry
      ? entry.selectionRange
      : identifierRange(document, entry.name, entry.location.range);
    const name = entry.name;

    // Document-symbol providers normally return symbols from the requested file,
    // but keep the guard in case a provider reports a workspace-level symbol.
    const isObjectLiteralMember = (entry.kind === vscode.SymbolKind.Property || entry.kind === vscode.SymbolKind.Key) &&
      parentKind !== vscode.SymbolKind.Class && parentKind !== vscode.SymbolKind.Interface &&
      parentKind !== vscode.SymbolKind.Struct && parentKind !== vscode.SymbolKind.Enum;
    const key = `${uri.toString()}:${range.start.line}:${range.start.character}`;
    if (!isObjectLiteralMember && !seen.has(key) && uri.toString() === document.uri.toString() &&
        !isAnnotationSymbol(name) &&
        !hasLeadingOverride(document, range.start.line) &&
        !isHtmlTagName(document, range.start)) {
      seen.add(key);
      locations.push(new vscode.Location(uri, new vscode.Range(range.start, range.start)));
    }

    if ('children' in entry) collectSymbolsInto(document, entry.children, locations, limit, seen, entry.kind);
  }
}

function isHtmlTagName(document: vscode.TextDocument, position: vscode.Position): boolean {
  if (!['html', 'xml', 'vue', 'svelte', 'astro', 'javascriptreact', 'typescriptreact'].includes(document.languageId)) {
    return false;
  }

  const line = document.lineAt(position.line).text;
  // HTML providers often anchor an element lens at the start of its full range,
  // rather than at the tag name, so inspect the entire line.
  return /<\s*\/?\s*[a-z][\w:.-]*(?:\s|\/?>)/i.test(line);
}

function identifierRange(
  document: vscode.TextDocument,
  name: string,
  container: vscode.Range
): vscode.Range {
  const source = document.getText(container);
  // Some flat providers put the parameter signature in the symbol's name.
  const identifier = name.split('(')[0].trim();
  const escapedName = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|[^\\p{L}\\p{N}_$])(${escapedName})(?![\\p{L}\\p{N}_$])`, 'u').exec(source);
  if (!match || match.index === undefined) return container;

  const nameOffset = document.offsetAt(container.start) + match.index + match[1].length;
  const start = document.positionAt(nameOffset);
  const end = document.positionAt(nameOffset + identifier.length);
  return new vscode.Range(start, end);
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  action: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await action(item);
    }
  });
  await Promise.all(workers);
}

function isAnnotationSymbol(name: string): boolean {
  return /^\s*@/.test(name);
}

function hasLeadingOverride(document: vscode.TextDocument, symbolLine: number): boolean {
  for (let line = symbolLine - 1; line >= 0; line--) {
    const text = document.lineAt(line).text.trim();
    if (text.length === 0) continue;
    if (/^@(?:java\.lang\.)?override\b/i.test(text)) return true;
    // Other annotations (Component, Injectable, Autowired...) do not hide symbols.
    if (!text.startsWith('@')) return false;
  }
  return false;
}

function filterReferences(
  references: vscode.Location[],
  declaration: vscode.Location,
  includeDeclaration: boolean
): vscode.Location[] {
  const isDeclaration = (reference: vscode.Location) =>
    reference.uri.toString() === declaration.uri.toString() &&
    reference.range.start.isEqual(declaration.range.start);
  return includeDeclaration ? references : references.filter(reference => !isDeclaration(reference));
}

export function deactivate(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  for (const timer of delayedRefreshTimers) clearTimeout(timer);
  delayedRefreshTimers.clear();
}
