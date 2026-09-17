# Doppler Radar System

Run the secured dashboard from this folder with:

```powershell
node server.js
```

Then open `http://localhost:8080` in a browser. Do not open the HTML file directly: the authentication and role checks are served by `server.js`.

The server creates `users.json` on its first launch, with the three default accounts supplied for this project. That file stores only PBKDF2 password hashes, unique user IDs, roles, account status, and last-login information. Keep `users.json` private and do not commit it to source control.

Sessions expire after 30 minutes. The dashboard’s protected user-management API rejects unauthenticated and non-administrator requests, regardless of whether someone manually exposes a hidden front-end control.
