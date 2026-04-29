# ZeelandCamper website

Nieuwe website voor ZeelandCamper met een eenvoudige login en dashboard.

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
