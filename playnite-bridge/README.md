# Playnite Bridge — Synchronisation Playnite ↔ PlayPad

Un script Node.js qui lit la base SQLite de **Playnite** et envoie tes jeux
directement à **PlayPad** (sur Render). Pas besoin de serveur local permanent.

---

## Méthode 1 : Push direct vers Render (recommandé)

Lit Playnite et synchronise directement avec ton PlayPad hébergé :

```powershell
cd playnite-bridge
npm install
$env:PLAYPAD_USER="ton_pseudo"
$env:PLAYPAD_PASS="ton_mot_de_passe"
node playnite-reader.js --push https://playpad-pfh7.onrender.com
```

Résultat : tes jeux Playnite apparaissent dans ta bibliothèque PlayPad.

---

## Méthode 2 : Export JSON + import manuel

Exporte la bibliothèque dans un fichier JSON :

```powershell
cd playnite-bridge
npm install
node playnite-reader.js
```

Ça génère `playnite-export.json`. Ensuite dans PlayPad :
1. Va dans **Ma Bibliothèque** → clique sur ⚡
2. En bas du panneau, clique **"Importer un fichier JSON"**
3. Sélectionne `playnite-export.json`

---

## Configuration

### Chemin personnalisé de library.db

```powershell
$env:PLAYNITE_DB_PATH = "D:\MesJeux\Playnite\library.db"
node playnite-reader.js --push https://playpad-pfh7.onrender.com
```

### Automatisation (Windows Task Scheduler)

Pour synchroniser automatiquement chaque semaine :
1. Ouvre **Task Scheduler**
2. Crée une tâche avec le déclencheur de ton choix
3. Action : `powershell.exe`
4. Arguments :
```
cd C:\...\playnite-bridge ; $env:PLAYPAD_USER="..."; $env:PLAYPAD_PASS="..."; node playnite-reader.js --push https://playpad-pfh7.onrender.com
```

---

## API du module (pour extension future)

```js
const { readPlayniteGames, filterByPlatform, groupByPlatform } = require('./playnite-reader');
const games = readPlayniteGames();          // tous les jeux
const steam = filterByPlatform(games, 'steam'); // filtrés par plateforme
```

Pour ajouter une source directe (Steam Web API, etc.) :
1. Crée un fichier `steam-web-reader.js` qui exporte `readGames(config)`
2. Importe-le dans `playnite-reader.js` ou crée une route dédiée
