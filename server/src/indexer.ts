import { Range, Position, SymbolKind } from 'vscode-languageserver/node';
import { keywords } from './language';

export interface JinkSymbol {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  isPublic: boolean;
  children?: JinkSymbol[]; // Struct fields
  parameters?: { name: string, type: string }[]; // Functions
}

export interface JinkImport {
  modulePath: string;
  alias?: string;
  isWildcard: boolean;
  names: { name: string, alias?: string }[];
  range: Range;
}

export class Indexer {
  private symbolsByName: Map<string, JinkSymbol[]> = new Map();
  private symbolsByUri: Map<string, JinkSymbol[]> = new Map();
  private importsByUri: Map<string, JinkImport[]> = new Map();

  public update(uri: string, text: string) {
    this.remove(uri);

    const newSymbols: JinkSymbol[] = [];
    const newImports: JinkImport[] = [];
    const lines = text.split(/\r?\n/g);

    const letPattern = /^(pub\s+)?let\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/;
    const constPatternUntyped = /^(pub\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/;
    const constPatternTyped = /^(pub\s+)?const\s+(?:[a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/;
    const typeAliasPattern = /^(pub\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/;
    const typeStructStartPattern = /^(pub\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*\{/;
    const functionPattern = /^(pub\s+)?fun\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)/;
    const externPattern = /^(pub\s+)?extern\s*\("[^"]*"\)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)/;
    const classPattern = /^(pub\s+)?cls\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(.*\))?\s*=/;
    const varPatternGlobal = /([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:;|=)/g;

    // import module
    // import module as alias
    // import module.sub
    // import module.sub as alias
    const importModulePattern = /^import\s+([a-zA-Z0-9_.]+)(?:\s+as\s+([a-zA-Z0-9_]+))?\s*;?$/;

    // import module.*
    const importWildcardPattern = /^import\s+([a-zA-Z0-9_.]+)\.\*\s*;?$/;

    // import from module { ... }
    const importFromPattern = /^import\s+from\s+([a-zA-Z0-9_.]+)\s*{(.*)}/;
    const importFromStartPattern = /^import\s+from\s+([a-zA-Z0-9_.]+)\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let match: RegExpMatchArray | null;

      // Imports
      if ((match = line.match(importModulePattern))) {
        newImports.push({
          modulePath: match[1],
          alias: match[2],
          isWildcard: false,
          names: [],
          range: Range.create(i, 0, i, line.length)
        });
        continue;
      } else if ((match = line.match(importWildcardPattern))) {
        newImports.push({
          modulePath: match[1],
          isWildcard: true,
          names: [],
          range: Range.create(i, 0, i, line.length)
        });
        continue;
      } else if ((match = line.match(importFromPattern))) {
        const modulePath = match[1];
        const content = match[2];
        const names: { name: string, alias?: string }[] = [];
        const parts = content.split(',');
        for (const part of parts) {
          const p = part.trim();
          if (p) {
            const asMatch = p.match(/^([a-zA-Z0-9_]+)\s+as\s+([a-zA-Z0-9_]+)$/);
            if (asMatch) {
              names.push({ name: asMatch[1], alias: asMatch[2] });
            } else {
              names.push({ name: p });
            }
          }
        }
        newImports.push({
          modulePath: modulePath,
          isWildcard: false,
          names: names,
          range: Range.create(i, 0, i, line.length)
        });
        continue;
      } else if ((match = line.match(importFromStartPattern))) {
        const modulePath = match[1];
        let content = line.substring(match[0].length);
        let endFound = line.includes('}');
        let currentLine = i;

        // If not ended on same line, consume subsequent lines
        while (!endFound && currentLine + 1 < lines.length) {
          currentLine++;
          const nextLine = lines[currentLine];
          content += " " + nextLine; // Add space to avoid merging words
          if (nextLine.includes('}')) {
            endFound = true;
          }
        }

        // Process content (remove } and everything after)
        content = content.split('}')[0];

        const names: { name: string, alias?: string }[] = [];
        const parts = content.split(',');
        for (const part of parts) {
          const p = part.trim();
          if (p) {
            const asMatch = p.match(/^([a-zA-Z0-9_]+)\s+as\s+([a-zA-Z0-9_]+)$/);
            if (asMatch) {
              names.push({ name: asMatch[1], alias: asMatch[2] });
            } else {
              names.push({ name: p });
            }
          }
        }
        newImports.push({
          modulePath: modulePath,
          isWildcard: false,
          names: names,
          range: Range.create(i, 0, currentLine, lines[currentLine].length)
        });

        // Update i to skip consumed lines
        i = currentLine;
        continue;
      }

      // Symbols
      if ((match = line.match(letPattern))) {
        const name = match[2];
        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Variable, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic: !!match[1] });
        }
        continue;
      } else if ((match = line.match(constPatternUntyped))) {
        const name = match[2];
        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Constant, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic: !!match[1] });
        }
        continue;
      } else if ((match = line.match(constPatternTyped))) {
        const name = match[2];
        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Constant, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic: !!match[1] });
        }
        continue;
      } else if ((match = line.match(typeStructStartPattern))) {
        const isPublic = !!match[1];
        const name = match[2];
        const kind = SymbolKind.Class;

        // Parse struct body
        const children: JinkSymbol[] = [];
        let content = line.substring(match[0].length);
        let endFound = line.includes('}');
        let currentLine = i;

        while (!endFound && currentLine + 1 < lines.length) {
          currentLine++;
          const nextLine = lines[currentLine];
          content += " " + nextLine;
          if (nextLine.includes('}')) {
            endFound = true;
          }
        }

        const body = content.split('}')[0];
        const fields = body.split(',');
        for (const field of fields) {
          const parts = field.split(':');
          if (parts.length === 2) {
            const fieldName = parts[0].trim();
            if (fieldName) {
              children.push({
                name: fieldName,
                kind: SymbolKind.Field,
                uri: uri,
                range: Range.create(i, 0, i, 0),
                isPublic: true
              });
            }
          }
        }
        i = currentLine;

        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic, children });
        }
        continue;
      } else if ((match = line.match(typeAliasPattern))) {
        const name = match[2];
        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Class, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic: !!match[1] });
        }
        continue;
      } else if ((match = line.match(functionPattern))) {
        const isPublic = !!match[1];
        const name = match[2];
        const argsStr = match[3];
        const parameters: { name: string, type: string }[] = [];
        if (argsStr.trim()) {
          const args = argsStr.split(',');
          for (const arg of args) {
            const parts = arg.trim().split(/\s+/);
            if (parts.length >= 2) {
              parameters.push({ name: parts[1], type: parts[0] });
            }
          }
        }
        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Function, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic, parameters });
        }
        continue;
      } else if ((match = line.match(externPattern))) {
        const isPublic = !!match[1];
        const name = match[2];
        const argsStr = match[3];
        const parameters: { name: string, type: string }[] = [];
        if (argsStr.trim()) {
          const args = argsStr.split(',');
          for (const arg of args) {
            const parts = arg.trim().split(/\s+/);
            if (parts.length >= 2) {
              parameters.push({ name: parts[1], type: parts[0] });
            }
          }
        }
        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Function, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic, parameters });
        }
        continue;
      } else if ((match = line.match(classPattern))) {
        const name = match[2];
        const startChar = line.indexOf(name);
        if (startChar !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Class, uri, range: Range.create(i, startChar, i, startChar + name.length), isPublic: !!match[1] });
        }
        continue;
      }

      // Check for variables (including multiple per line)
      const varMatches = Array.from(line.matchAll(varPatternGlobal));
      if (varMatches.length > 0) {
        for (const m of varMatches) {
          if (!keywords.includes(m[1])) {
            const name = m[2];
            const matchStart = m.index || 0;
            const typeLength = m[1].length;
            const textAfterType = m[0].substring(typeLength);
            const nameStartInMatch = typeLength + textAfterType.indexOf(name);
            const absoluteStart = matchStart + nameStartInMatch;

            newSymbols.push({
              name,
              kind: SymbolKind.Variable,
              uri,
              range: Range.create(i, absoluteStart, i, absoluteStart + name.length),
              isPublic: false
            });
          }
        }
      }
    }

    this.symbolsByUri.set(uri, newSymbols);
    this.importsByUri.set(uri, newImports);

    for (const sym of newSymbols) {
      const list = this.symbolsByName.get(sym.name) || [];
      list.push(sym);
      this.symbolsByName.set(sym.name, list);
    }
  }

  public remove(uri: string) {
    const symbols = this.symbolsByUri.get(uri);
    if (symbols) {
      for (const sym of symbols) {
        const list = this.symbolsByName.get(sym.name);
        if (list) {
          const newList = list.filter(s => s.uri !== uri);
          if (newList.length === 0) {
            this.symbolsByName.delete(sym.name);
          } else {
            this.symbolsByName.set(sym.name, newList);
          }
        }
      }
      this.symbolsByUri.delete(uri);
    }
    this.importsByUri.delete(uri);
  }

  public getImports(uri: string): JinkImport[] {
    return this.importsByUri.get(uri) || [];
  }

  public getDefinition(name: string): JinkSymbol[] {
    return this.symbolsByName.get(name) || [];
  }

  public getAllSymbols(): JinkSymbol[] {
    const all: JinkSymbol[] = [];
    for (const list of this.symbolsByName.values()) {
      all.push(...list);
    }
    return all;
  }

  public getKnownUris(): string[] {
    return Array.from(this.symbolsByUri.keys());
  }

  public getSymbolsInUri(uri: string): JinkSymbol[] {
    return this.symbolsByUri.get(uri) || [];
  }
}
