# ZeelandCamper website

Nieuwe website voor ZeelandCamper met een eenvoudige login en dashboard.

De voorkant toont het actuele voertuigenaanbod. Na login kun je voertuigen toevoegen, bewerken en verwijderen in het dashboard.

## Lokaal starten

```powershell
npm start
```

Open daarna `http://localhost:3000`.

## Login

Standaard lokaal:

- Gebruiker: `bram`
- Wachtwoord: `1234`

Voor Render is het beter om deze waarden als environment variables in te stellen:

- `SITE_USERNAME`
- `SITE_PASSWORD`
- `SESSION_SECRET`

## Render

Gebruik deze instellingen:

- Build Command: leeg laten
- Start Command: `npm start`
- Environment: `Node`

De huidige eenvoudige database staat in `data/vehicles.json`. Voor langdurige productieopslag is later een echte database zoals Render Postgres de beste vervolgstap.
