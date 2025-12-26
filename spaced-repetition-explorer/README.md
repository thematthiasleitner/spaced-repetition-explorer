# Spaced Repetition Explorer Extension

Browse your Obsidian Spaced Repetition flashcards ordered by ease or due date, with deck selection, keyboard navigation, and inline front/back rendering.

## Features
- Deck tree view with the same icon and feel as the Spaced Repetition plugin.
- Card browser sorted by lowest ease or earliest due date.
- Always shows ease and due date; front/back rendered together (answer appears under the question).
- Keyboard shortcuts: `Space` (toggle answer), `←/→` (prev/next card).
- Settings: show/hide ribbon icon, apply the Spaced Repetition “folders to ignore”, manual refresh from settings.

## Installation (manual)
1) Copy the `spaced-repetition-explorer` folder (containing `manifest.json`, `main.js`, `styles.css`, `versions.json`) into your vault’s `.obsidian/plugins/` directory.  
2) In Obsidian, enable **Community Plugins → Spaced Repetition Explorer Extension**.

## Publishing checklist
- `manifest.json` with `id`, `name`, `version`, `minAppVersion`, and `main`.
- `versions.json` tracking releases.
- `main.js` bundle with plugin code.
- `styles.css` (even if minimal) for future styling.
- A tagged release (e.g., `0.1.0`) containing these files for the Obsidian community catalog.
