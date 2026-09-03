# Icons

This folder holds chatbot icons, organized by model family. The Go engine
embeds this entire `web/` directory via `//go:embed all:web` and serves it
at `/`, so any file you add here is automatically available at
`/icons/<family>/<file>`.

## Folder structure

```
icons/
  default/        ← used when no model is selected yet
    icon-01.svg
    icon-02.svg
    ...
  anthropic/      ← used when an Anthropic model (Opus / Sonnet / Haiku) is active
    icon-01.svg
    icon-02.svg
    ...
  openai/         ← used when a GPT-4o / o1 / etc. model is active
    ...
  google/         ← Gemini / Gemma
  deepseek/
  qwen/
  glm/
  meta/           ← Llama
  mistral/
```

## How to add icons

1. Create a subfolder named after the family (must match a key in
   `../config/families.json`).
2. Drop SVG files inside, named however you like
   (`icon-01.svg`, `robot.svg`, `ghost.svg`, …).
3. List each file's URL in `../config/families.json` under the family's
   `"icons"` array, e.g.:

   ```json
   "anthropic": {
     "label": "Anthropic",
     "color": "#d97757",
     "icons": [
       "/icons/anthropic/icon-01.svg",
       "/icons/anthropic/icon-02.svg",
       "/icons/anthropic/ghost.svg"
     ]
   }
   ```

4. Rebuild the engine (`make build-engine` from the repo root). Go's
   `//go:embed` will bundle the new files into the binary automatically —
   no build step on the JS side.

## Icon requirements

- **Format:** SVG (preferred — scalable, tiny, editable in Figma /
  Illustrator / Inkscape). PNG also works but is less crisp on high-DPI
  screens.
- **Size:** any square viewport. The CSS `object-fit: cover` will fit it
  into the 56×56 px chatbot icon container.
- **Background:** transparent — the container itself is a circle, so
  transparent SVGs sit nicely inside it. If you want a colored bg, set
  the family's `"color"` field in `families.json` (also used as the
  placeholder color when no real icons are listed).
- **Style:** simple, bold, recognizable at 56 px. Avoid fine detail.

## How the picker works

When a new chatbot is created, the `IconPicker` for the active family
selects an icon index at random from the family's `icons` array. It
follows a **no-repeat-until-exhausted** rule: every icon in the family
is used once before any icon is reused. If there are more chatbots in
the canvas than icons available, repeats are allowed.

The same rule applies to **names** (see `../config/names.json`): the
`NamePicker` cycles through the list without repetition until all names
are in use, then allows repeats.

When the active model family changes (e.g. user switches from
"anthropic" to "glm"), every existing chatbot gets a fresh icon from
the new family's set, again following the no-repeat rule.
