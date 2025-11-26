import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  DocumentDiagnosticReportKind,
  type DocumentDiagnosticReport,
  DefinitionParams,
  Location,
  SymbolKind
} from "vscode-languageserver/node";

import {
  TextDocument
} from "vscode-languageserver-textdocument";

import { Indexer } from './indexer';
import { keywords, builtins as languageBuiltins, declarationKeywords } from './language';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const indexer = new Indexer();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true
      },
      definitionProvider: true,
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false
      }
    }
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }
  return result;
});

connection.onInitialized(() => {
  connection.console.info("Server initialized");
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log("Workspace folder change event received.");
    });
    connection.workspace.getWorkspaceFolders().then(folders => {
      if (folders) {
        scanWorkspace(folders.map(f => f.uri));
      }
    });
  }
});

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 100 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.languageServerExample || defaultSettings)
    );
  }
  // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
  // We could optimize things here and re-fetch the setting first can compare it
  // to the existing setting, but this is out of scope for this example.
  connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "jinkLanguageServer"
    });
    documentSettings.set(resource, result);
  }
  return result;
}

documents.onDidClose(e => {
  documentSettings.delete(e.document.uri);
});

connection.languages.diagnostics.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (document !== undefined) {
    return {
      kind: DocumentDiagnosticReportKind.Full,
      items: await validateTextDocument(document)
    } satisfies DocumentDiagnosticReport;
  } else {
    // We don't know the document. We can either try to read it from disk or we don't report problems for it
    return {
      kind: DocumentDiagnosticReportKind.Full,
      items: []
    } satisfies DocumentDiagnosticReport;
  }
});

// The content of a text document has changed
// Emitted when the text document first opened or when its content has changed
documents.onDidChangeContent(change => {
  indexer.update(change.document.uri, change.document.getText());
  validateTextDocument(change.document);
});

// Parse the names of defined variables, types, functions and classes
function parseJinkDocumentNamesAsCompletionItem(document: TextDocument): CompletionItem[] {
  const text = document.getText();
  const lines = text.split(/\r?\n/g);

  const names: CompletionItem[] = [];

  // let a = 5;
  const letPattern = /^let\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/;
  // const a = 5; pub const b = 6;
  const constPatternUntyped = /^(pub\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/;
  // const int a = 5; pub const string b = "hello";
  const constPatternTyped = /^(pub\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/;
  // type a = int;
  const typeAliasPattern = /^(pub\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)/;
  // type b = {a: int, b: string};
  const typeStructPattern = /^(pub\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*{(.*)}/;
  // fun a() {}; pub fun b() {}
  const functionPattern = /^(pub\s+)?fun\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(.*\)\s*/;
  // cls a = {}; pub cls b(a) = {}
  const classPattern = /^(pub\s+)?cls\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(\(.*\))?\s*=\s*(.*)/;
  // any other type
  // int a; float b; string c = "hello";
  let varPattern = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(;|\s*=\s*(.*))/;
  for (const line of lines) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(letPattern))) {
      names.push({
        label: match[1],
        kind: CompletionItemKind.Variable
      });
    } else if ((match = line.match(constPatternUntyped))) {
      names.push({
        label: match[2],
        kind: CompletionItemKind.Constant
      });
    } else if ((match = line.match(constPatternTyped))) {
      names.push({
        label: match[3],
        kind: CompletionItemKind.Constant
      });
    } else if ((match = line.match(typeAliasPattern))) {
      names.push({
        label: match[2],
        kind: CompletionItemKind.TypeParameter
      });
    } else if ((match = line.match(typeStructPattern))) {
      names.push({
        label: match[2],
        kind: CompletionItemKind.Struct
      });
    } else if ((match = line.match(functionPattern))) {
      names.push({
        label: match[2],
        kind: CompletionItemKind.Function
      });
    } else if ((match = line.match(classPattern))) {
      names.push({
        label: match[2],
        kind: CompletionItemKind.Class
      });
    } else if ((match = line.match(varPattern))) {
      names.push({
        label: match[2],
        kind: CompletionItemKind.Variable
      });
    }
  }

  return names;
}

function getAutocompleteSuggestions(document: TextDocument, position: number): CompletionItem[] {
  const text = document.getText();
  const lines = text.split(/\r?\n/g);
  const line = lines[position];
  const word = line.split(/\s+/).pop();
  if (word === undefined) return [];
  const suggestions: CompletionItem[] = [];
  const definedNames = parseJinkDocumentNamesAsCompletionItem(document);
  for (const name of definedNames) {
    if (name.label.toLowerCase().startsWith(word.toLowerCase())) {
      suggestions.push(name);
    }
  }
  return suggestions;
}

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
  // In this simple example we get the settings for every validate run
  // TODO: maxNumberOfProblems
  const settings = await getDocumentSettings(textDocument.uri);

  const text = textDocument.getText();
  // Strip comments for validation
  const cleanText = text.replace(/\/\/.*$/gm, match => ' '.repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));

  const lines = cleanText.split(/\r?\n/g);
  const diagnostics: Diagnostic[] = [];

  // Collect all imported names to check for usage
  const importedNames: { name: string, range: { start: { line: number, character: number }, end: { line: number, character: number } } }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check imports
    const importMatch = line.match(/^import\s+from\s+([a-zA-Z0-9_.]+)\s*(?:{(.*)})?/);
    const importStartMatch = line.match(/^import\s+from\s+([a-zA-Z0-9_.]+)\s*\{/);
    const wildcardImportMatch = line.match(/^import\s+([a-zA-Z0-9_.]+)\.\*\s*;?/);
    const simpleImportMatch = line.match(/^import\s+([a-zA-Z0-9_.]+)(?:\s+as\s+([a-zA-Z0-9_]+))?\s*;?/);

    if (importStartMatch && !line.includes('}')) {
      // Multi-line import
      const importPath = importStartMatch[1];
      let content = line.substring(importStartMatch[0].length);
      let endFound = false;
      let currentLine = i;

      while (!endFound && currentLine + 1 < lines.length) {
        currentLine++;
        const nextLine = lines[currentLine];
        content += " " + nextLine;
        if (nextLine.includes('}')) {
          endFound = true;
        }
      }

      content = content.split('}')[0];

      // Validate module existence
      const expectedSuffix = importPath.replace(/\./g, '/') + '.jk';
      const knownUris = indexer.getKnownUris();
      const moduleUri = knownUris.find(u => u.endsWith(expectedSuffix));

      if (!moduleUri) {
        const start = line.indexOf(importPath);
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: { line: i, character: start }, end: { line: i, character: start + importPath.length } },
          message: `Module '${importPath}' not found.`,
          source: 'jink'
        });
      } else {
        // Validate symbols
        const moduleSymbols = indexer.getSymbolsInUri(moduleUri);
        const importedSymbols = content.split(',');
        for (const symStr of importedSymbols) {
          const parts = symStr.trim().split(/\s+as\s+/);
          const symName = parts[0];

          if (symName) {
            const symbol = moduleSymbols.find(s => s.name === symName);
            if (!symbol) {
              // We can't easily find the exact location in multi-line string without more complex parsing
              // So we just report at the start of the import for now, or try to find it in the lines we consumed
              // A simple heuristic: search in the lines we processed
              let foundLine = -1;
              let foundChar = -1;
              for (let k = i; k <= currentLine; k++) {
                const l = lines[k];
                const idx = l.indexOf(symName);
                if (idx !== -1) {
                  foundLine = k;
                  foundChar = idx;
                  break;
                }
              }

              if (foundLine !== -1) {
                diagnostics.push({
                  severity: DiagnosticSeverity.Error,
                  range: { start: { line: foundLine, character: foundChar }, end: { line: foundLine, character: foundChar + symName.length } },
                  message: `Symbol '${symName}' not found in module '${importPath}'.`,
                  source: 'jink'
                });
              }
            } else if (!symbol.isPublic) {
              let foundLine = -1;
              let foundChar = -1;
              for (let k = i; k <= currentLine; k++) {
                const l = lines[k];
                const idx = l.indexOf(symName);
                if (idx !== -1) {
                  foundLine = k;
                  foundChar = idx;
                  break;
                }
              }

              if (foundLine !== -1) {
                diagnostics.push({
                  severity: DiagnosticSeverity.Error,
                  range: { start: { line: foundLine, character: foundChar }, end: { line: foundLine, character: foundChar + symName.length } },
                  message: `Symbol '${symName}' is not public in module '${importPath}'.`,
                  source: 'jink'
                });
              }
            }
            // Track for unused check
            if (symbol) {
              let foundLine = -1;
              let foundChar = -1;
              // Find location of the name (or alias if present)
              const searchName = parts[1] || symName;
              for (let k = i; k <= currentLine; k++) {
                const l = lines[k];
                const idx = l.indexOf(searchName);
                if (idx !== -1) {
                  foundLine = k;
                  foundChar = idx;
                  break;
                }
              }
              if (foundLine !== -1) {
                importedNames.push({ name: searchName, range: { start: { line: foundLine, character: foundChar }, end: { line: foundLine, character: foundChar + searchName.length } } });
              }
            }
          }
        }
      }

      i = currentLine; // Skip processed lines
      continue;
    }

    if (importMatch) {
      const importPath = importMatch[1];
      const importedSymbolsStr = importMatch[2];

      // Validate module existence
      const expectedSuffix = importPath.replace(/\./g, '/') + '.jk';
      const knownUris = indexer.getKnownUris();
      const moduleUri = knownUris.find(u => u.endsWith(expectedSuffix));

      if (!moduleUri) {
        const start = line.indexOf(importPath);
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: { line: i, character: start }, end: { line: i, character: start + importPath.length } },
          message: `Module '${importPath}' not found.`,
          source: 'jink'
        });
      } else {
        // Check imported symbols
        if (importedSymbolsStr) {
          const moduleSymbols = indexer.getSymbolsInUri(moduleUri);
          const importedSymbols = importedSymbolsStr.split(',');
          for (const symStr of importedSymbols) {
            const parts = symStr.trim().split(/\s+as\s+/);
            const symName = parts[0];
            const alias = parts[1];
            const nameToCheck = alias || symName;

            if (symName) {
              const symbol = moduleSymbols.find(s => s.name === symName);
              if (!symbol) {
                const symStart = line.indexOf(symName, line.indexOf('{')); // Approximate location
                diagnostics.push({
                  severity: DiagnosticSeverity.Error,
                  range: { start: { line: i, character: symStart }, end: { line: i, character: symStart + symName.length } },
                  message: `Symbol '${symName}' not found in module '${importPath}'.`,
                  source: 'jink'
                });
              } else if (!symbol.isPublic) {
                const symStart = line.indexOf(symName, line.indexOf('{')); // Approximate location
                diagnostics.push({
                  severity: DiagnosticSeverity.Error,
                  range: { start: { line: i, character: symStart }, end: { line: i, character: symStart + symName.length } },
                  message: `Symbol '${symName}' is not public in module '${importPath}'.`,
                  source: 'jink'
                });
              }

              // Track for unused check
              if (symbol) {
                const searchName = alias || symName;
                const symStart = line.indexOf(searchName, line.indexOf('{'));
                if (symStart !== -1) {
                  importedNames.push({ name: searchName, range: { start: { line: i, character: symStart }, end: { line: i, character: symStart + searchName.length } } });
                }
              }
            }
          }
        } else {
          // import module or import module as alias
          // Check for alias
          const asMatch = line.match(/as\s+([a-zA-Z0-9_]+)/);
          if (asMatch) {
            const alias = asMatch[1];
            const start = line.indexOf(alias);
            importedNames.push({ name: alias, range: { start: { line: i, character: start }, end: { line: i, character: start + alias.length } } });
          }
        }
      }
    } else if (wildcardImportMatch) {
      const importPath = wildcardImportMatch[1];
      // Validate module existence
      const expectedSuffix = importPath.replace(/\./g, '/') + '.jk';
      const knownUris = indexer.getKnownUris();
      const moduleUri = knownUris.find(u => u.endsWith(expectedSuffix));

      if (!moduleUri) {
        const start = line.indexOf(importPath);
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: { line: i, character: start }, end: { line: i, character: start + importPath.length } },
          message: `Module '${importPath}' not found.`,
          source: 'jink'
        });
      }
    } else if (simpleImportMatch) {
      // Handle 'import module;' or 'import module as alias;'
      const importPath = simpleImportMatch[1];
      const alias = simpleImportMatch[2];

      // Validate module existence
      const expectedSuffix = importPath.replace(/\./g, '/') + '.jk';
      const knownUris = indexer.getKnownUris();
      const moduleUri = knownUris.find(u => u.endsWith(expectedSuffix));

      if (!moduleUri) {
        const start = line.indexOf(importPath);
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: { line: i, character: start }, end: { line: i, character: start + importPath.length } },
          message: `Module '${importPath}' not found.`,
          source: 'jink'
        });
      } else {
        if (alias) {
          const start = line.indexOf(alias);
          importedNames.push({ name: alias, range: { start: { line: i, character: start }, end: { line: i, character: start + alias.length } } });
        } else {
          // Last part of the path is used as namespace
          // 'import std.io;' -> 'io.print'
          const parts = importPath.split('.');
          const name = parts[parts.length - 1];
          const start = line.indexOf(importPath) + importPath.lastIndexOf(name);
          importedNames.push({ name: name, range: { start: { line: i, character: start }, end: { line: i, character: start + name.length } } });
        }
      }
    }
  }

  // Check for unused imports
  for (const imp of importedNames) {
    const regex = new RegExp(`\\b${imp.name}\\b`, 'g');
    const matches = cleanText.match(regex);
    // matches includes import definition itself, so expect at least 1 match
    // If only 1 match, unused
    if (matches && matches.length === 1) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: imp.range,
        message: `Import '${imp.name}' is unused.`,
        source: 'jink'
      });
    }
  }

  // Symbol resolution and scope analysis
  // Tokenize the text to handle scopes and variable declarations

  // Initialize Global Scope
  const globalScope = new Set<string>();

  // Add built-in types and keywords that act as values/types
  const builtins = languageBuiltins;
  builtins.forEach(b => globalScope.add(b));

  // Add top-level symbols from Indexer (this file)
  const localSymbols = indexer.getSymbolsInUri(textDocument.uri);
  localSymbols.forEach(s => globalScope.add(s.name));

  // Add imported symbols
  const imports = indexer.getImports(textDocument.uri);
  for (const imp of imports) {
    imp.names.forEach(n => globalScope.add(n.alias || n.name));
    if (imp.alias) {
      globalScope.add(imp.alias);
    } else if (!imp.names.length && !imp.isWildcard) {
      // import module; -> module name is available
      const parts = imp.modulePath.split('.');
      globalScope.add(parts[parts.length - 1]);
    }
  }

  // Add known module roots (namespaces)
  // If we have 'jink/ext/libc.jk', 'jink' is valid root
  const knownUris = indexer.getKnownUris();
  const knownRoots = new Set<string>();
  for (const uri of knownUris) {
    // Extract module path from URI
    // .../src/jink/ext/libc.jk -> jink
    const parts = uri.split('/');
    const srcIndex = parts.indexOf('src');
    if (srcIndex !== -1 && srcIndex < parts.length - 1) {
      knownRoots.add(parts[srcIndex + 1]);
    }
  }
  knownRoots.forEach(r => globalScope.add(r));

  // Initialize scope stack
  const scopeStack: Set<string>[] = [globalScope];
  let match;

  // Args to add to the next scope (function body)
  let pendingArgs: string[] = [];

  // Reset
  scopeStack.length = 1; // Keep global

  // State Stack for nested structures
  enum State {
    NORMAL,
    DECL_EXPECTED,
    FUN_ARGS,
    TYPE_DEF,
    STRUCT_BODY,
    OBJECT_LITERAL,
    IMPORT_STMT,
    RETURN_TYPE,
    EXTERN_DECL,
    EXTERN_ABI,
    ENUM_BODY
  }

  const stateStack: State[] = [State.NORMAL];
  let lastToken = '';
  let lastDeclKeyword = '';
  let lastTokenWasKeyword = false;
  let expectingFunArgs = false;

  const keywordPattern = keywords.join('|');
  const tokenRegex = new RegExp(`("(?:[^"\\\\]|\\\\.)*")|(\\b(${keywordPattern})\\b)|(\\b[a-zA-Z_][a-zA-Z0-9_]*\\b)|(\\->)|([{}();=.,:\\[\\]+\\-*/%<>&|!^~])`, 'g');

  while ((match = tokenRegex.exec(cleanText)) !== null) {
    const isString = !!match[1];
    const isKeyword = !!match[2];
    const keyword = match[3];
    const isIdentifier = !!match[4];
    const identifier = match[4];
    const isArrow = !!match[5];
    const isPunctuation = !!match[6];
    const punctuation = match[6];
    const index = match.index;

    const currentState = stateStack[stateStack.length - 1];

    if (isString) {
      lastToken = 'string';
      lastTokenWasKeyword = false;
      expectingFunArgs = false;
      continue;
    }

    if (isArrow) {
      stateStack.push(State.RETURN_TYPE);
      lastToken = '->';
      lastTokenWasKeyword = false;
      continue;
    }

    if (isKeyword) {
      if (declarationKeywords.includes(keyword)) {
        lastDeclKeyword = keyword;
      }

      if (keyword === 'fun' || keyword === 'cls') {
        expectingFunArgs = true;
      } else {
        expectingFunArgs = false;
      }

      if (keyword === 'import') {
        stateStack.push(State.IMPORT_STMT);
      } else if (keyword === 'extern') {
        stateStack.push(State.EXTERN_DECL);
      }

      lastToken = keyword;
      lastTokenWasKeyword = true;
      continue;
    }

    if (isPunctuation) {
      if (punctuation === '{') {
        expectingFunArgs = false;

        if (currentState === State.RETURN_TYPE) {
          stateStack.pop(); // Exit return type
        }

        if (currentState === State.IMPORT_STMT) {
          // Inside import block, stay in IMPORT_STMT or push it again to handle matching }
          stateStack.push(State.IMPORT_STMT);
          // We don't need a scope for imports, but to keep stack aligned if we used it:
          // scopeStack.push(new Set()); 
          // Actually, let's just ignore scope for imports.
          continue;
        }

        const newScope = new Set<string>();
        pendingArgs.forEach(arg => newScope.add(arg));
        pendingArgs = [];
        scopeStack.push(newScope);

        // Determine new state
        if (lastToken === 'type') {
          stateStack.push(State.STRUCT_BODY);
        } else if (lastDeclKeyword === 'enum' && lastToken === '=') {
          stateStack.push(State.ENUM_BODY);
        } else if (lastToken === '=' || lastToken === '(' || lastToken === ',' || lastToken === ':' || lastToken === 'return' || lastToken === '[') {
          stateStack.push(State.OBJECT_LITERAL);
        } else {
          stateStack.push(State.NORMAL);
        }
      } else if (punctuation === '}') {
        expectingFunArgs = false;

        if (currentState === State.IMPORT_STMT) {
          stateStack.pop();
          continue;
        }

        if (scopeStack.length > 1) {
          scopeStack.pop();
        }
        if (stateStack.length > 1) {
          stateStack.pop();
        }
      } else if (punctuation === '(') {
        if (expectingFunArgs) {
          stateStack.push(State.FUN_ARGS);
          expectingFunArgs = false;
        } else if (currentState === State.EXTERN_DECL) {
          // If immediately after extern, it's ABI: extern("C")
          if (lastToken === 'extern') {
            stateStack.push(State.EXTERN_ABI);
          } else {
            // Otherwise it's args: extern ... name(...)
            stateStack.push(State.FUN_ARGS);
          }
        } else {
          // Just a parenthesized expression or call
          expectingFunArgs = false;
        }
      } else if (punctuation === ')') {
        expectingFunArgs = false;
        if (currentState === State.FUN_ARGS) {
          stateStack.pop();
        } else if (currentState === State.EXTERN_ABI) {
          stateStack.pop();
        }
      } else if (punctuation === ';') {
        if (currentState === State.IMPORT_STMT || currentState === State.RETURN_TYPE) {
          stateStack.pop();
        }
        if (stateStack[stateStack.length - 1] === State.EXTERN_DECL) {
          stateStack.pop();
        }
        pendingArgs = []; // Clear args for externs
        expectingFunArgs = false;
      } else {
        expectingFunArgs = false;
      }

      lastToken = punctuation;
      lastTokenWasKeyword = false;
      continue;
    }

    if (isIdentifier) {
      // Check if property access
      if (index > 0 && cleanText[index - 1] === '.') {
        // Check for ...args (Rest parameters)
        const isRest = index >= 3 && cleanText.substring(index - 3, index) === '...';
        if (!isRest) {
          lastToken = identifier;
          lastTokenWasKeyword = false;
          expectingFunArgs = false;
          continue;
        }
      }

      if (currentState === State.IMPORT_STMT || currentState === State.RETURN_TYPE || currentState === State.EXTERN_ABI || currentState === State.ENUM_BODY) {
        lastToken = identifier;
        lastTokenWasKeyword = false;
        continue;
      }

      // Handle Declarations
      // If last token was a declaration keyword
      if (declarationKeywords.includes(lastToken)) {
        scopeStack[scopeStack.length - 1].add(identifier);
        lastToken = identifier;
        lastTokenWasKeyword = false;
        // Do NOT reset expectingFunArgs here, as 'fun name' needs it for '('
        continue;
      }

      // Handle declarations
      // If last token was an identifier (and not a keyword), treat current as declaration
      // We check if lastToken looks like an identifier to avoid matching punctuation/operators
      if (!lastTokenWasKeyword && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(lastToken)) {
        scopeStack[scopeStack.length - 1].add(identifier);
        lastToken = identifier;
        lastTokenWasKeyword = false;
        continue;
      }

      if (currentState === State.EXTERN_DECL) {
        // Identifier in EXTERN_DECL is the function name
        scopeStack[scopeStack.length - 1].add(identifier);
        lastToken = identifier;
        lastTokenWasKeyword = false;
        continue;
      }

      expectingFunArgs = false;

      // Handle Function Args
      if (currentState === State.FUN_ARGS) {
        // Check if it's a type usage (preceded by :)
        // Scan back
        let j = index - 1;
        while (j >= 0 && /\s/.test(cleanText[j])) j--;
        if (cleanText[j] === ':') {
          // Type usage -> Validate
        } else {
          // Arg declaration
          pendingArgs.push(identifier);
          lastToken = identifier;
          lastTokenWasKeyword = false;
          continue;
        }
      }

      // Handle Struct Body (Keys)
      if (currentState === State.STRUCT_BODY) {
        // Check if followed by :
        let j = index + identifier.length;
        while (j < cleanText.length && /\s/.test(cleanText[j])) j++;
        if (cleanText[j] === ':') {
          // Field definition
          lastToken = identifier;
          lastTokenWasKeyword = false;
          continue;
        }
      }

      // Handle Object Literal (Keys)
      if (currentState === State.OBJECT_LITERAL) {
        // Check if followed by :
        let j = index + identifier.length;
        while (j < cleanText.length && /\s/.test(cleanText[j])) j++;
        if (cleanText[j] === ':') {
          // Object key
          lastToken = identifier;
          lastTokenWasKeyword = false;
          continue;
        }
      }

      // Usage Check
      let found = false;
      // Check scopes from inner to outer
      for (let k = scopeStack.length - 1; k >= 0; k--) {
        if (scopeStack[k].has(identifier)) {
          found = true;
          break;
        }
      }

      // Check wildcard imports
      if (!found) {
        for (const imp of imports) {
          if (imp.isWildcard) {
            const expectedSuffix = imp.modulePath.replace(/\./g, '/') + '.jk';
            const modUri = knownUris.find(u => u.endsWith(expectedSuffix));
            if (modUri) {
              const syms = indexer.getSymbolsInUri(modUri);
              if (syms.some(s => s.name === identifier && s.isPublic)) {
                found = true;
                break;
              }
            }
          }
        }
      }

      if (!found) {
        const pos = textDocument.positionAt(index);
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: pos, end: { line: pos.line, character: pos.character + identifier.length } },
          message: `Undefined symbol '${identifier}'.`,
          source: 'jink'
        });
      }

      lastToken = identifier;
      lastTokenWasKeyword = false;
    }
  }

  return diagnostics;
}

connection.onDidChangeWatchedFiles(_change => {
  connection.console.log("We received a file change event");
});

// Get autocompletion items
connection.onCompletion(
  (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (document === undefined) { return []; }
    const position = textDocumentPosition.position;
    const items = getAutocompleteSuggestions(document, position.line);

    // Track added items to prevent duplicates
    const addedLabels = new Set<string>();
    items.forEach(i => addedLabels.add(i.label));

    // Add global symbols for auto-import
    const allSymbols = indexer.getAllSymbols();
    const currentUri = document.uri.toLowerCase();

    for (const sym of allSymbols) {
      const symUri = sym.uri.toLowerCase();
      if (symUri !== currentUri && sym.isPublic) {
        // Check if already imported
        const imports = indexer.getImports(document.uri);
        let alreadyImported = false;
        for (const imp of imports) {
          if (imp.names.some(n => (n.alias || n.name) === sym.name)) {
            alreadyImported = true;
            break;
          }
          if (imp.isWildcard) {
            const expectedSuffix = imp.modulePath.replace(/\./g, '/') + '.jk';
            if (sym.uri.endsWith(expectedSuffix) || symUri.endsWith(expectedSuffix.toLowerCase())) {
              alreadyImported = true;
              break;
            }
          }
        }

        if (!alreadyImported) {
          // Deduplicate
          if (addedLabels.has(sym.name)) continue;

          // Calculate module path
          // Assuming standard layout: src/module/file.jk -> module.file
          // TODO: Find relative path from workspace root
          // For now extract from URI
          let modulePath = "";
          const parts = sym.uri.split('/');
          const srcIndex = parts.indexOf('src');
          if (srcIndex !== -1 && srcIndex < parts.length - 1) {
            const moduleParts = parts.slice(srcIndex + 1);
            const fileName = moduleParts[moduleParts.length - 1];
            if (fileName.endsWith('.jk')) {
              moduleParts[moduleParts.length - 1] = fileName.substring(0, fileName.length - 3);
              modulePath = moduleParts.join('.');
            }
          }

          if (modulePath) {
            items.push({
              label: sym.name,
              kind: sym.kind === SymbolKind.Function ? CompletionItemKind.Function :
                sym.kind === SymbolKind.Class ? CompletionItemKind.Class :
                  sym.kind === SymbolKind.Constant ? CompletionItemKind.Constant : CompletionItemKind.Variable,
              detail: `Auto-import from ${modulePath}`,
              additionalTextEdits: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: `import from ${modulePath} { ${sym.name} };\n`
              }]
            });
            addedLabels.add(sym.name);
          }
        }
      }
    }

    return items;
  }
);

// Resolve additional information for the item selected in the completion list
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {

    // TODO: Item details / documentation

    return item;
  }
);

async function scanWorkspace(folderUris: string[]) {
  for (const folderUri of folderUris) {
    const folderPath = fileURLToPath(folderUri);
    const files = getAllJinkFiles(folderPath);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      const uri = pathToFileURL(file).toString();
      indexer.update(uri, text);
    }
  }
}

function getAllJinkFiles(dir: string): string[] {
  let results: string[] = [];
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        if (!['.git', 'node_modules', 'dist', 'out', 'build', 'target'].includes(file)) {
          results = results.concat(getAllJinkFiles(filePath));
        }
      } else {
        if (filePath.endsWith('.jk')) {
          results.push(filePath);
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }
  return results;
}

function getWordAtPosition(line: string, character: number): string | null {
  const wordRegex = /[a-zA-Z0-9_]+/g;
  let match;
  while ((match = wordRegex.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return match[0];
    }
  }
  return null;
}

connection.onDefinition((params: DefinitionParams): Location[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const text = document.getText();
  const position = params.position;
  const lines = text.split(/\r?\n/g);
  const line = lines[position.line];

  // Check for import path
  const importMatch = line.match(/^import\s+(?:from\s+)?([a-zA-Z0-9_.]+)/);
  if (importMatch) {
    const importPath = importMatch[1];
    const start = line.indexOf(importPath);
    const end = start + importPath.length;
    if (position.character >= start && position.character <= end) {
      // Resolve import path
      // jink.ext.libc -> jink/ext/libc.jk
      const expectedSuffix = importPath.replace(/\./g, '/') + '.jk';
      const knownUris = indexer.getKnownUris();
      for (const uri of knownUris) {
        if (uri.endsWith(expectedSuffix)) {
          return [Location.create(uri, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } })];
        }
      }
    }
  }

  // Check for identifier
  const word = getWordAtPosition(line, position.character);
  if (word) {
    // 1. Check local definitions in the current file
    const localSymbols = indexer.getSymbolsInUri(document.uri);
    const localDef = localSymbols.find(s => s.name === word);
    if (localDef) {
      return [Location.create(localDef.uri, localDef.range)];
    }

    // 2. Check imports
    const imports = indexer.getImports(document.uri);
    for (const imp of imports) {
      // Check named imports: import from module { name }
      const namedImport = imp.names.find(n => (n.alias || n.name) === word);
      if (namedImport) {
        const targetName = namedImport.name;
        const expectedSuffix = imp.modulePath.replace(/\./g, '/') + '.jk';
        const knownUris = indexer.getKnownUris();
        const moduleUri = knownUris.find(u => u.endsWith(expectedSuffix));
        if (moduleUri) {
          const moduleSymbols = indexer.getSymbolsInUri(moduleUri);
          const targetSymbol = moduleSymbols.find(s => s.name === targetName);
          if (targetSymbol) {
            return [Location.create(targetSymbol.uri, targetSymbol.range)];
          }
        }
      }

      // Check wildcard imports: import module.*
      if (imp.isWildcard) {
        const expectedSuffix = imp.modulePath.replace(/\./g, '/') + '.jk';
        const knownUris = indexer.getKnownUris();
        const moduleUri = knownUris.find(u => u.endsWith(expectedSuffix));
        if (moduleUri) {
          const moduleSymbols = indexer.getSymbolsInUri(moduleUri);
          const targetSymbol = moduleSymbols.find(s => s.name === word && s.isPublic);
          if (targetSymbol) {
            return [Location.create(targetSymbol.uri, targetSymbol.range)];
          }
        }
      }
    }

    // 3. Check for module.symbol access
    // Need to see if the word is preceded by dot and module name/alias
    // Find start of word
    const wordStart = line.indexOf(word, position.character - word.length - 1); // Approximate, but getWordAtPosition doesn't return range
    // Find exact range of word at position
    const wordRegex = /[a-zA-Z0-9_]+/g;
    let match;
    let exactStart = -1;
    while ((match = wordRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        if (match[0] === word) {
          exactStart = start;
          break;
        }
      }
    }

    if (exactStart > 0 && line[exactStart - 1] === '.') {
      // It is property access, check the word before the dot
      const prevWord = getWordAtPosition(line, exactStart - 2);
      if (prevWord) {
        // prevWord is the module alias or name
        // Find import that matches prevWord
        const moduleImport = imports.find(i => {
          if (i.alias === prevWord) return true;
          if (!i.alias && i.modulePath === prevWord) return true; // import std; -> std.print
          if (!i.alias && i.modulePath.endsWith('.' + prevWord)) return true; // import std.io; -> io.print
          return false;
        });

        if (moduleImport) {
          const expectedSuffix = moduleImport.modulePath.replace(/\./g, '/') + '.jk';
          const knownUris = indexer.getKnownUris();
          const moduleUri = knownUris.find(u => u.endsWith(expectedSuffix));
          if (moduleUri) {
            const moduleSymbols = indexer.getSymbolsInUri(moduleUri);
            const targetSymbol = moduleSymbols.find(s => s.name === word && s.isPublic);
            if (targetSymbol) {
              return [Location.create(targetSymbol.uri, targetSymbol.range)];
            }
          }
        }
      }
    }

    // 4. Check if word is module alias/name
    const matchingImport = imports.find(i => {
      if (i.alias === word) return true;
      if (!i.alias) {
        const parts = i.modulePath.split('.');
        const defaultName = parts[parts.length - 1];
        return defaultName === word;
      }
      return false;
    });

    if (matchingImport) {
      return [Location.create(document.uri, matchingImport.range)];
    }

    return [];
  }

  return [];
});

// Make document manager listen on connection for open, change and close text document events
documents.listen(connection);

// Listen on connection
connection.listen();