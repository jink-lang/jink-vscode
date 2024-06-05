import * as path from "path";
import { workspace, ExtensionContext } from "vscode";

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	const serverModule = context.asAbsolutePath(
		path.join("server", "out", "server.js")
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc }
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for Jink files
		documentSelector: [{ scheme: "file", language: "jink" }],
		synchronize: {
			// Notify the server about file changes to '.jk files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher("**/.jk")
		}
	};

	// Create the language client and start the client
	client = new LanguageClient(
		"jinkLanguageServer",
		"Jink Language Server",
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) return undefined;
	return client.stop();
}