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
	type DocumentDiagnosticReport
} from "vscode-languageserver/node";

import {
	TextDocument
} from "vscode-languageserver-textdocument";

const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

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
	const settings = await getDocumentSettings(textDocument.uri);

  // TODO: Diagnose document

	// const text = textDocument.getText();
	// const pattern =
	// let m: RegExpExecArray | null;
	// let problems = 0;
	const diagnostics: Diagnostic[] = [];
	// while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
  // }
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

// Make document manager listen on connection for open, change and close text document events
documents.listen(connection);

// Listen on connection
connection.listen();