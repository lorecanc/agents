# Default Light Typography

Uses Google Fonts (embedded automatically in PPTX export).

## Font Families

| Family | Weight | Usage |
|---|---|---|
| **Inter** | 400, 500, 600, 700 | Body text, UI labels, paragraphs |
| **Merriweather** | 400, 700 | Headings, display titles, pull quotes |
| **IBM Plex Mono** | 400, 500 | Code, data, monospace labels |

## CSS

```css
--font-display: 'Merriweather', serif;
--font-heading: 'Inter', sans-serif;
--font-body: 'Inter', sans-serif;
--font-mono: 'IBM Plex Mono', monospace;
```

## Google Fonts CDN

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Merriweather:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
```
