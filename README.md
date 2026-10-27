# Transaction Ledger API

A Node.js transaction ledger API backed by SQLite. It supports account creation, immutable credits and debits, balance retrieval, paginated transaction history, and atomic account-to-account transfers.

## Requirements

Node.js **22.5+** is required because the application uses Node's built-in SQLite driver.

## Run locally

```bash
npm start
```

The service runs at `http://localhost:3000`. It persists data in `ledger.sqlite` by default.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port. |
| `LEDGER_DB_PATH` | `ledger.sqlite` | SQLite database file path. |

## Test

```bash
npm test
```

## Documentation

- [API Documentation](API_DOCUMENTATION.md)
- [Assumptions](ASSUMPTIONS.md)
