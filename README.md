# Quiz Night

## Run the app

Set credentials in `.env` before starting the server. `QUIZ_AUTH_USER` is
supported; `QUIZ_AUTH_USERNAME` is also accepted:

```dotenv
QUIZ_AUTH_USER=host
QUIZ_AUTH_PASSWORD=replace-this-with-a-unique-password-of-at-least-8-characters
```

The server loads `.env` automatically. Environment variables already set by
the host take precedence over values in the file.

Quiz state defaults to `.quiz-state.json` in the app directory. To keep it on a
Render persistent disk, mount the disk (for example at `/var/data`) and set
`QUIZ_STATE_FILE=/var/data/.quiz-state.json` in the service environment. A path
outside the app directory alone is not persistent unless it is on a mounted
persistent disk.

The shared HTTP Basic Auth credentials protect `/`, `/admin`, and `/scores`.
The `/projector` and `/teams` displays remain public. State updates from
unauthenticated Socket.IO clients are rejected.

Use HTTPS when hosting the app outside a trusted local network. Basic Auth
credentials are not encrypted unless the connection is protected by TLS.
