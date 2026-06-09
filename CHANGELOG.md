# Change Log

All notable changes to the Jink VS Code extension will be documented in this file.

## [0.2.1] - 2026-06-08
### Added
- Added the `__ptr_read_ptr`, `__ptr_write_ptr`, `__ptr_read_f32`, `__ptr_write_f32`, `__ptr_read_byte`, and `__ptr_write_byte` pointer builtins.

### Changed
- Upgraded the language client and server to the LSP v10 libraries; minimum supported VS Code is now 1.91.
- Bundled the client and server with esbuild, shrinking the packaged extension and speeding up activation.
- Upgraded TypeScript to 6.0 and refreshed dev tooling, type definitions, and the build/watch configuration.

## [0.2.0] - 2025-11-25
### Added
- Added Go-to-Definition support for variables, functions, classes, types, and enums.
- Added Auto-Import completion suggestions.
- Added workspace symbol scanning to find definitions and add Go-to-Def across modules.
- Added `enum` validation and snippets.
- Added import validation and unused warnings.
- Improved variable definition/declaration support and added unused warnings and undefined errors.
- Added additional snippets: `extern`, `import`, `if`, `while`, `for`.

### Fixed
- Corrected alphanumeric identifiers being mislabeled.

## [0.1.0] - 2024-06-05
### Fixed
- Fixed dependencies and finalize initial LSP functionality.

## [0.0.9] - 2024-06-05
### Added
- Added language server with support for auto-completion of defined variables, functions, classes and types.
- Added snippets for printf extern and function, class, and type definition.

## [0.0.8] - 2024-06-03
### Added
- Added syntax highlighting for `break` and `continue` statements.

## [0.0.7] - 2024-05-22
### Added
- Added theme-supported icons.

## [0.0.6] - 2024-05-22
### Added
- Added icons.

## [0.0.5] - 2024-04-23
### Added
- Updated keyword, type and operator syntax highlighting.

## [0.0.4] - 2024-04-17
### Fixed
- Syntax highlighting for block comments.

## [0.0.3] - 2019-01-04
### Added
- Syntax highlighting for division operator, more keywords and function calls.

## [0.0.2] - 2018-06-27
### Added
- Syntax highlighting for single-quoted strings, both line and block comments, operators and numbers.

## [0.0.1] - 2018-04-09
- Initial Release
