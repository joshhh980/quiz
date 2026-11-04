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

When `DATABASE_URL` is set, quiz state is stored in PostgreSQL in the
`quiz_state` table. Set it to Render Postgres's **internal** connection URL
when the web service and database are in the same Render region. The app
creates its table automatically. TLS is enabled by default for database
connections; set `DATABASE_SSL=false` only when connecting to a local
PostgreSQL instance without TLS.

For Render, create a Postgres database and add its internal connection URL to
the web service's `DATABASE_URL` environment variable. Free Render Postgres
instances currently expire after 30 days, so export any scores you need to
keep or upgrade the database before expiry.

Without `DATABASE_URL`, quiz state falls back to `.quiz-state.json` in the app
directory. To persist that file on Render instead, mount a disk (for example
at `/var/data`) and set `QUIZ_STATE_FILE=/var/data/.quiz-state.json`.

The shared HTTP Basic Auth credentials protect `/`, `/admin`, and `/scores`.
The `/projector` and `/teams` displays remain public. State updates from
unauthenticated Socket.IO clients are rejected.

Use HTTPS when hosting the app outside a trusted local network. Basic Auth
credentials are not encrypted unless the connection is protected by TLS.
