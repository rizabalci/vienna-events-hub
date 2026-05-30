# Vienna Events Hub

A mobile-first, PWA-ready event discovery app for Vienna, Austria covering concerts, classical music, theater, exhibitions, and special events.

![Vienna Events Hub](https://img.shields.io/badge/Events-512+-C9A84C) ![Mobile First](https://img.shields.io/badge/Mobile-First-66BB6A) ![PWA Ready](https://img.shields.io/badge/PWA-Ready-4285F4)

## Live Demo

**[View Live App](https://rizabalci.github.io/vienna-events-hub/)**

## Features

- **512+ curated events** across 15 categories (Feb-Mar 2026)
- **Bilingual support** (English/German toggle)
- **Dark/Light mode** with smooth transitions
- **Smart filtering** by date range and category
- **Natural language search** across titles, venues, descriptions
- **Bookmark system** with local storage persistence
- **Google Calendar integration** for easy event saving
- **Responsive design** optimized for mobile viewports
- **Zero dependencies** — pure HTML/CSS/JavaScript

## Categories

| Category | Events | Highlights |
|----------|--------|------------|
| Concerts | 300+ | Kraftklub, Alfa Mist, LaBrassBanda, Feuerschwanz |
| Classical | 50+ | Vienna Philharmonic, London Philharmonic, Anne-Sophie Mutter |
| Jazz | 30+ | Porgy & Bess programming, Ibrahim Maalouf, Bugge Wesseltoft |
| Opera | 25+ | Staatsoper, Volksoper, Theater an der Wien |
| Theater | 20+ | Burgtheater, Josefstadt, English-language productions |
| Kabarett | 15+ | Alex Kristan, Michael Niavarani, Kaya Yanar |
| Exhibitions | 20+ | Belvedere, Leopold Museum, MAK, Albertina |
| Special Events | 30+ | Vienna Opera Ball, Fasching, Art Fairs |

## Tech Stack

- **Single-file architecture** — entire app in one HTML file (278KB)
- **CSS custom properties** for theming
- **Vanilla JavaScript** with no frameworks
- **Local Storage** for user preferences and bookmarks
- **Google Fonts** (Cormorant Garamond, DM Sans)

## Design Philosophy

- Clean, editorial aesthetic inspired by luxury event guides
- Gold accent color (#C9A84C) throughout
- Smooth animations and micro-interactions
- Touch-optimized controls for mobile users
- Safe area insets for notched devices

## Local Development

```bash
# Clone the repository
git clone https://github.com/rizabalci/vienna-events-hub.git
cd vienna-events-hub

# Open in browser (no build step required)
open index.html
# or
python -m http.server 8000
```

## Deployment

The app is deployed via GitHub Pages. Any push to `main` automatically updates the live site.

## Author

**Riza Balci** — Vienna-based consultant specializing in e-commerce and AI-augmented workflows.

## License

MIT License — feel free to use as inspiration for your own event apps.
