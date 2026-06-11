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
    // Signatures may span multiple lines, so these only match the opening of the parameter list
    // The full list is collected with collectParenList below
    const functionStart = /^(pub\s+)?fun\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
    const externStart = /^(pub\s+)?extern\s*\("[^"]*"\)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
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
      } else if ((match = line.match(functionStart)) || (match = line.match(externStart))) {
        // Function / extern decl. The param list may span multiple lines and individual params may have function types
        // such as fun(int) -> int cb, so collect the whole parenthesized list and split it on top-level commas rather than single-line parsing
        const isPublic = !!match[1];
        const name = match[2];
        const rawLine = lines[i];
        const nameIdx = rawLine.indexOf(name);
        const openCol = rawLine.indexOf('(', nameIdx + name.length);
        const { inner, endLine } = collectParenList(lines, i, openCol);
        const parameters: { name: string, type: string }[] = [];
        for (const part of splitTopLevelCommas(inner)) {
          const param = parseParam(part);
          if (param) {
            parameters.push(param);
          }
        }
        if (nameIdx !== -1) {
          newSymbols.push({ name, kind: SymbolKind.Function, uri, range: Range.create(i, nameIdx, i, nameIdx + name.length), isPublic, parameters });
        }
        i = endLine; // Skip any consumed continuation lines
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

// Collect a parenthesized list that may span multiple lines, starting from the
// '(' at openCol on startLine - returns the inner text (newlines collapsed to spaces)
// and the index of the line holding the matching ')'
function collectParenList(lines: string[], startLine: number, openCol: number): { inner: string, endLine: number } {
  let depth = 0;
  let inner = '';
  for (let li = startLine; li < lines.length; li++) {
    const ln = lines[li];
    const from = li === startLine ? openCol : 0;
    for (let c = from; c < ln.length; c++) {
      const ch = ln[c];
      if (ch === '(') {
        depth++;
        if (depth === 1) continue; // Skip the outer opening paren
      } else if (ch === ')') {
        depth--;
        if (depth === 0) return { inner, endLine: li };
      }
      if (depth >= 1) inner += ch;
    }
    inner += ' ';
  }
  return { inner, endLine: lines.length - 1 };
}

// Split a param list on top-level commas, ignoring commas nested in
// parentheses/brackets/braces (like inside a fun(int, int) -> int param type)
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseParam(p: string): { name: string, type: string } | null {
  const ids = p.match(/[a-zA-Z_][a-zA-Z0-9_]*/g);
  if (!ids || ids.length === 0) return null;
  const name = ids[ids.length - 1];
  const trimmed = p.trim();
  const type = trimmed.slice(0, trimmed.lastIndexOf(name)).trim() || trimmed;
  return { name, type };
}
