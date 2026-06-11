# Jink for VS Code

> Jink language support for Visual Studio Code

## Features

This extension adds support for the **[Jink](https://github.com/jink-lang/jink)** programming language!

The extension provides:
- Name resolution and auto-completion for defined variables, functions, classes, types and enums.
- Auto-import module completion suggestions.
- Go-to-Def support for variables, functions, classes, types and enums across modules.
- Simple snippets for: function, class, type, enum and control flow.
- Syntax highlighting for keywords, types, operators, numbers, strings and comments.
- Theme-supported icons.

### For more information

* [Jink](https://github.com/jink-lang/jink)
* [Github Repository](https://github.com/jink-lang/jink-vscode)
* [Full Changelog](https://github.com/jink-lang/jink-vscode/blob/master/CHANGELOG.md)

## Latest Release Notes

### [0.3.0] - 2026-06-11
### Added
- Added support for first-class functions - function-type parameters such as `fun(int) -> int cb` are now parsed correctly, and the parameters of such functions are recognized in the function body instead of being reported as undefined.

### Fixed
- Indexed functions and externs whose signatures span multiple lines. Previously their exports were never recorded so they reported as undefined everywhere they got imported.
- Added Go-to-Definition for function-type parameters - a reference such as `cb(x)` now jumps to the parameter's declaration in the enclosing function signature.

## License

This project is distributed under the MIT License - see the [license file](LICENSE) for details.

Copyright © 2018-2025 Jacob Noah, jink-lang contributors

**Enjoy!**
