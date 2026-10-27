# API Documentation

Base URL: `http://localhost:3000`

All request bodies must be JSON objects. All error responses use:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable explanation" } }
```

## Create account

`POST /accounts`

```json
{ "name": "Ada Lovelace" }
```

Returns `201 Created`. Account IDs and timestamps are system generated. The balance always begins at `0`. A request containing a `balance` property is rejected with `400 INITIAL_BALANCE_NOT_ALLOWED`.

## Get account

`GET /accounts/:accountId`

Returns `200 OK` with the account, including its current balance.

## Get balance

`GET /accounts/:accountId/balance`

Returns `200 OK`:

```json
{ "account_id": "account-uuid", "balance": 100 }
```

## Add transaction

`POST /accounts/:accountId/transactions`

```json
{
  "type": "credit",
  "amount": 125.5,
  "description": "Invoice payment",
  "reference_id": "invoice-1001"
}
```

Returns `201 Created` with the immutable transaction and the updated balance. `type` must be `credit` or `debit`; `amount` must be a positive number with at most two decimal places. A debit cannot exceed the account balance. `reference_id` must be unique within its account.

## Get transaction history

`GET /accounts/:accountId/transactions?type=credit&page=1&limit=20`

Query parameters:

| Parameter | Required | Details |
| --- | --- | --- |
| `type` | No | `credit` or `debit`; omit for both. |
| `page` | No | Positive integer; default `1`. |
| `limit` | No | Positive integer from `1` to `100`; default `20`. |

Transactions are latest-first by `created_at`. Returns `200 OK`:

```json
{
  "transactions": [],
  "pagination": {
    "current_page": 1,
    "page_size": 20,
    "total_records": 0,
    "total_pages": 0
  }
}
```

## Transfer funds

`POST /transfers`

```json
{
  "source_account_id": "source-uuid",
  "destination_account_id": "destination-uuid",
  "amount": 30,
  "description": "Settlement",
  "reference_id": "settlement-1"
}
```

Returns `201 Created`. Both accounts must exist, must differ, and the source must have sufficient funds. The debit and credit are persisted atomically.

## Health check

`GET /health` returns `200 OK` with `{ "status": "ok" }`.

## Status codes

| Status | Meaning | Examples |
| --- | --- | --- |
| `400` | Invalid input | Invalid JSON, request body, transaction type, amount, or pagination. |
| `404` | Resource not found | Unknown account or route. |
| `409` | Conflict | Duplicate transaction reference. |
| `422` | Business-rule failure | Insufficient balance. |
| `500` | Unexpected server error | Unhandled infrastructure error. |
