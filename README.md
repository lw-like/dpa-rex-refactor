# DPA-REX-Refacror

VS Code extension for bulk regex find-and-replace across files, with saved pattern support and Angular component extraction tools.

---

## Features

- **Bulk find & replace** — regex with capture groups, flags, and scope control (current file, open files, workspace, glob)
- **Pattern Planner** — analyze selected text to generate regex suggestions interactively
- **Replacement chains** — multi-step pipelines where each step's output feeds the next
- **Saved patterns** — name and reuse patterns across sessions; export/import as JSON
- **Angular tab** — extract selected HTML into a standalone Angular v21+ component, with:
  - CSS/SCSS class usage analysis (BEM `&` concatenation aware)
  - Single-use class detection and migration to component SCSS
  - Child component import resolution
  - Per-component `.todo.json` checklist to track cleanup of origin files

---

## Development

```bash
npm install        # install dependencies
npm run compile    # one-off TypeScript compile
npm run watch      # watch mode (recompiles on save)
npm run lint       # ESLint
npm test           # run tests (launches Extension Development Host)
```

Press **F5** in VS Code to launch a development instance of the extension.

---

## Building a production package

Install the VS Code Extension CLI if you don't have it:

```bash
npm install -g @vscode/vsce
```

Build the `.vsix` package:

```bash
npm run vscode:prepublish   # minified compile
vsce package                # produces dpa-rex-refacror-<version>.vsix
```

The `.vsix` file will appear in the project root.

---

## Installing the package manually

### Option 1 — VS Code UI

1. Open VS Code
2. Go to the Extensions view (`Ctrl+Shift+X`)
3. Click the **`···`** menu (top-right of the Extensions panel)
4. Select **Install from VSIX…**
5. Pick the `.vsix` file

### Option 2 — Command line

```bash
code --install-extension dpa-rex-refacror-0.1.0.vsix
```

Replace `0.1.0` with the actual version from the filename.

### Option 3 — Command Palette

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **Extensions: Install from VSIX…**
3. Pick the `.vsix` file

After installation, reload VS Code (`Ctrl+Shift+P` → **Developer: Reload Window**).

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Open sidebar panel |
| `Ctrl+Shift+Alt+R` | Analyze selection in Planner |
| `Ctrl+Shift+Alt+A` | Extract selection to Angular component |
