# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-20

### Added

- `promptlinter` CLI with stylish, JSON and GitHub Actions output, `--var`/`--vars`, `--syntax`, `--max-tokens`, `--max-warnings`, `--quiet`, `--stdin` and `--rules`.
- 19 rules for template syntax, variables, structure, content and style.
- Mustache, Handlebars, Jinja, f-string / LangChain and `${js}` placeholders, detected per file.
- Variables from frontmatter (`variables`, `input_variables`, Prompty `inputs`), the CLI or the config.
- Config files with `include`, `ignore`, `rules` and per-file `overrides`; inline `promptlinter-disable` comments.
- `lint()`, `lintFiles()`, `loadConfig()`, `defineConfig()` and the formatters as a library.

[0.1.0]: https://github.com/acus9345/promptlinter/releases/tag/v0.1.0
