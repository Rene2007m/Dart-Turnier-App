---

## 📖 Anleitungen & Handbuch

### 🛠️ Für Turnier-Organisatoren & Admins

#### 1. Neues Turnier erstellen
1. Als Admin einloggen.
2. Im Dashboard auf **`➕ Neu`** klicken.
3. Namen für das Turnier vergeben.
4. Option **„👥 Gruppenphase aktivieren“** wählen (falls gewünscht).
5. Spieler eintragen (oder via **„🎲 Spieler zufällig auslosen“** mischen lassen).
6. Auf **`🚀 Starten`** klicken.

#### 2. Ergebnisse eintragen & Turnierfortschritt
- **Gruppenphase / Bracket:** Klicke als Admin einfach auf ein beliebiges Match im Turnierbaum oder in der Gruppenansicht.
- **Ergebnis eingeben:** Trage die Leg-Punkte der beiden Spieler ein und klicke auf **`💾 Speichern`**.
- **Automatische Logik:**
  - Gewinner rücken automatisch in die nächste Runde vor.
  - Verlierer im Winner Bracket werden automatisch ins Second Chance (Loser) Bracket verschoben.
  - Sind alle Gruppenspiele beendet, werden die K.o.-Runden (Gold- & Bronze-Runde) automatisch generiert.

#### 3. Spiele planen (Kalender)
1. Klicke im Dashboard auf die Kachel **Spielplanung**.
2. Wähle im Kalender das gewünschte Datum aus und klicke auf **`➕ Spiel planen`**.
3. Wähle eine offene Paarung aus der Liste aus, gib Uhrzeit und Dauer an und speichere.
4. *Hinweis:* Die geplante Uhrzeit wird automatisch auf der Match-Karte im Turnierbaum angezeigt!

---

## 💻 Entwickler-Anleitung: Code anpassen & erweitern

Falls du den Code anpassen oder neue Funktionen einbauen möchtest, findest du hier die wichtigsten Orientierungspunkte:

### 🎯 Wichtigste Stellen im Code (`script.js`)

| Was möchtest du ändern? | Wo im Code? | Beschreibung / Funktion |
| :--- | :--- | :--- |
| **Datenbank-Namen & Sammlungen** | `CONFIG`-Objekt *(ca. Zeile 8)* | Hier werden die Firestore-Kollektionen definiert (`tournaments`, `users`, `planned_games` etc.). |
| **Passwort-Anforderung & Verschlüsselung** | `hashPassword()` / `CRYPTO_KEY` | Steuert das Hashing der Passwörter (SHA-256) sowie die Verschlüsselung der Anmeldenamen. |
| **Turnier-Logik & Weiterkommen** | `TournamentManager`-Klasse | Hier steckt die komplette Mathematik für Brackets, Freilose (`BYE`), Gruppenphasen und das Stepladder-Finale. |
| **Match-Ergebnisse verarbeiten** | `handleResult()` | Steuert, was passiert, wenn ein Admin ein Ergebnis speichert (Runden-Weiterleitung, News-Post, Auto-Archivierung). |
| **Design & Einstellungen** | `SETTINGS_DEFAULTS` & `applySettings()` | Standardwerte für das Layout (Farben, Brackets-Stil, Kompaktmodus). |

---

### 🎨 Design & Farbschemas anpassen (`styles.css`)

- **Hauptfarben ändern:**
  Die zentralen Farben der Anwendung sind ganz oben in der `styles.css` über CSS-Variablen definiert:
  ```css
  :root {
      --bg: #0f172a;        /* Hintergrundfarbe */
      --primary: #3b82f6;   /* Haupt-Akzentfarbe (Blau) */
      --success: #10b981;   /* Siege / Erfolgsmeldungen (Grün) */
      --danger: #ef4444;    /* Niederlagen / Löschen (Rot) */
      --text: #f8fafc;      /* Textfarbe */
  }
