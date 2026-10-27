const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

class LedgerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class Ledger {
  constructor(databasePath = ':memory:') {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        description TEXT NOT NULL CHECK (length(trim(description)) > 0),
        reference_id TEXT NOT NULL CHECK (length(trim(reference_id)) > 0),
        created_at TEXT NOT NULL,
        UNIQUE(account_id, reference_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS transactions_account_created_at
        ON transactions(account_id, created_at DESC);
    `);
  }

  createAccount(input) {
    const body = requireObject(input);
    if (Object.hasOwn(body, 'balance')) throw new LedgerError(400, 'INITIAL_BALANCE_NOT_ALLOWED', 'initial balance is system-managed and must not be provided');
    const { name } = body;
    if (typeof name !== 'string' || !name.trim()) throw new LedgerError(400, 'INVALID_NAME', 'name is required and must be a non-empty string');
    const account = { id: randomUUID(), name: name.trim(), balance_cents: 0, created_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO accounts (id, name, balance_cents, created_at) VALUES (?, ?, ?, ?)').run(account.id, account.name, account.balance_cents, account.created_at);
    return presentAccount(account);
  }

  addTransaction(accountId, input) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const account = this.getAccountRecord(accountId);
      const transaction = this.validateTransaction(accountId, input, account.balance_cents);
      this.updateBalance(accountId, transaction.delta_cents);
      this.insertTransaction(transaction);
      this.db.exec('COMMIT');
      return { transaction: presentTransaction(transaction), balance: centsToAmount(account.balance_cents + transaction.delta_cents) };
    } catch (error) {
      this.rollback();
      if (isUniqueConstraint(error)) throw new LedgerError(409, 'DUPLICATE_REFERENCE_ID', 'reference_id must be unique within an account');
      throw error;
    }
  }

  transfer(input) {
    const { source_account_id: sourceAccountId, destination_account_id: destinationAccountId, amount, description, reference_id: referenceId } = requireObject(input);
    if (typeof sourceAccountId !== 'string' || !sourceAccountId || typeof destinationAccountId !== 'string' || !destinationAccountId) throw new LedgerError(400, 'INVALID_ACCOUNT_ID', 'source_account_id and destination_account_id are required');
    if (sourceAccountId === destinationAccountId) throw new LedgerError(400, 'SAME_ACCOUNT_TRANSFER', 'source and destination accounts must differ');
    if (typeof referenceId !== 'string' || !referenceId.trim()) throw new LedgerError(400, 'INVALID_REFERENCE_ID', 'reference_id is required and must be a non-empty string');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const source = this.getAccountRecord(sourceAccountId);
      const destination = this.getAccountRecord(destinationAccountId);
      const transferReference = referenceId.trim();
      const debit = this.validateTransaction(sourceAccountId, { type: 'debit', amount, description, reference_id: `${transferReference}:debit` }, source.balance_cents);
      const credit = this.validateTransaction(destinationAccountId, { type: 'credit', amount, description, reference_id: `${transferReference}:credit` }, destination.balance_cents);
      this.updateBalance(sourceAccountId, debit.delta_cents);
      this.updateBalance(destinationAccountId, credit.delta_cents);
      this.insertTransaction(debit);
      this.insertTransaction(credit);
      this.db.exec('COMMIT');
      return {
        transfer_id: randomUUID(),
        source_transaction: presentTransaction(debit),
        destination_transaction: presentTransaction(credit),
        source_balance: centsToAmount(source.balance_cents + debit.delta_cents),
        destination_balance: centsToAmount(destination.balance_cents + credit.delta_cents),
      };
    } catch (error) {
      this.rollback();
      if (isUniqueConstraint(error)) throw new LedgerError(409, 'DUPLICATE_REFERENCE_ID', 'transfer reference_id has already been used for an account');
      throw error;
    }
  }

  validateTransaction(accountId, input, balanceCents) {
    const { type, amount, description, reference_id: referenceId } = requireObject(input);
    if (type !== 'credit' && type !== 'debit') throw new LedgerError(400, 'INVALID_TYPE', 'type must be either credit or debit');
    const amountCents = amountToCents(amount);
    if (typeof description !== 'string' || !description.trim()) throw new LedgerError(400, 'INVALID_DESCRIPTION', 'description is required and must be a non-empty string');
    if (typeof referenceId !== 'string' || !referenceId.trim()) throw new LedgerError(400, 'INVALID_REFERENCE_ID', 'reference_id is required and must be a non-empty string');
    if (type === 'debit' && amountCents > balanceCents) throw new LedgerError(422, 'INSUFFICIENT_BALANCE', 'account has insufficient balance');
    const deltaCents = type === 'credit' ? amountCents : -amountCents;
    return { id: randomUUID(), account_id: accountId, type, amount_cents: amountCents, description: description.trim(), reference_id: referenceId.trim(), created_at: new Date().toISOString(), delta_cents: deltaCents };
  }

  updateBalance(accountId, deltaCents) {
    const result = this.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND balance_cents + ? >= 0').run(deltaCents, accountId, deltaCents);
    if (result.changes !== 1) throw new LedgerError(422, 'INSUFFICIENT_BALANCE', 'account has insufficient balance');
  }

  insertTransaction(transaction) {
    this.db.prepare('INSERT INTO transactions (id, account_id, type, amount_cents, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(transaction.id, transaction.account_id, transaction.type, transaction.amount_cents, transaction.description, transaction.reference_id, transaction.created_at);
  }

  getAccount(accountId) { return presentAccount(this.getAccountRecord(accountId)); }

  getAccountRecord(accountId) {
    const account = this.db.prepare('SELECT id, name, balance_cents, created_at FROM accounts WHERE id = ?').get(accountId);
    if (!account) throw new LedgerError(404, 'ACCOUNT_NOT_FOUND', 'account not found');
    return account;
  }

  getTransactions(accountId, { type, page, limit } = {}) {
    this.getAccountRecord(accountId);
    if (type !== undefined && type !== 'credit' && type !== 'debit') throw new LedgerError(400, 'INVALID_TYPE_FILTER', 'type must be either credit or debit');
    const currentPage = parsePositiveInteger(page, 1, 'page');
    const pageSize = parsePositiveInteger(limit, 20, 'limit');
    if (pageSize > 100) throw new LedgerError(400, 'INVALID_LIMIT', 'limit must not exceed 100');
    const filter = type ? ' AND type = ?' : '';
    const params = type ? [accountId, type] : [accountId];
    const totalRecords = this.db.prepare(`SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?${filter}`).get(...params).count;
    const transactions = this.db.prepare(`SELECT id, account_id, type, amount_cents, description, reference_id, created_at FROM transactions WHERE account_id = ?${filter} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (currentPage - 1) * pageSize).map(presentTransaction);
    return { transactions, pagination: { current_page: currentPage, page_size: pageSize, total_records: totalRecords, total_pages: Math.ceil(totalRecords / pageSize) } };
  }

  rollback() { try { this.db.exec('ROLLBACK'); } catch { /* no transaction was open */ } }
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LedgerError(400, 'INVALID_REQUEST_BODY', 'request body must be a JSON object');
  return value;
}
function amountToCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) {
    throw new LedgerError(400, 'INVALID_AMOUNT', 'amount must be a positive number with at most two decimal places');
  }
  return Math.round(amount * 100);
}
function centsToAmount(cents) { return cents / 100; }
function presentAccount(account) { return { id: account.id, name: account.name, balance: centsToAmount(account.balance_cents), created_at: account.created_at }; }
function presentTransaction(transaction) { return { id: transaction.id, account_id: transaction.account_id, type: transaction.type, amount: centsToAmount(transaction.amount_cents), description: transaction.description, reference_id: transaction.reference_id, created_at: transaction.created_at }; }
function parsePositiveInteger(value, defaultValue, fieldName) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new LedgerError(400, `INVALID_${fieldName.toUpperCase()}`, `${fieldName} must be a positive integer`);
  return Number(value);
}
function isUniqueConstraint(error) { return error && String(error.message).includes('UNIQUE constraint failed'); }

module.exports = { Ledger, LedgerError };
