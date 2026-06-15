# TCL Temps Réel — Design System V1

## Objectif
Créer une interface cohérente, premium, fluide, inspirée Tesla / iOS :
- mêmes boutons partout
- mêmes cartes partout
- mêmes flèches partout
- mêmes icônes transport partout
- mêmes scrollbars partout
- mêmes couleurs dark/light partout
- même logique visuelle pour trafic, véhicules, nearby, timeline, menus

## Principes
1. Ne pas casser la logique existante.
2. Ne pas toucher au moteur Bus Tracker / GTFS / trafic.
3. Appliquer le design par couches.
4. Tester après chaque couche.
5. Réduire progressivement les styles inline et les !important.

## Tokens globaux
- Fond app : bleu nuit profond
- Surface : verre sombre / verre clair
- Accent principal : bleu électrique
- Accent bus : bleu
- Accent tram : violet
- Accent chrono : orange
- Succès : vert
- Alerte : orange
- Perturbation : rouge
- Texte principal : très lisible
- Texte secondaire : gris bleuté

## Composants à uniformiser

### Navigation
- Retour : chevron iOS unique
- Ouverture/repli : chevron bas/haut unique
- Aucun mélange ←, ‹, ›, ▾, ▸, ⌄, ⌃ sans règle

### Boutons
- Primary
- Secondary
- Ghost
- Icon button
- Pill / chip
- Close button

### Cartes
- Home card
- Quick card
- Live card
- Traffic box
- Nearby line
- Network row
- Modal panel

### Transport
- Badge ligne
- Icône bus
- Icône tram
- Icône métro
- Icône chrono
- Icône véhicule
- Badge retard / approche / terminus

### Recherche
- Un seul style input
- Une seule hauteur
- Même bordure
- Même focus
- Même placeholder

### Scroll
- Scrollbar fine
- Couleur cohérente
- Pas de scroll brutal
- Pas de jump visuel

### Mode clair/sombre
- Même structure visuelle
- Couleurs adaptées
- Pas de composants oubliés

## Ordre de patch recommandé

1. Fondation tokens CSS
2. Boutons + champs + scrollbars
3. Cartes globales
4. Navigation / flèches
5. Badges transport
6. Nearby
7. Véhicules
8. Trafic
9. Timeline
10. Nettoyage des anciens styles

