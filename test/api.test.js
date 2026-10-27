const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/app');

let server;
let baseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('creates an account with system-managed zero balance', async () => {
  const result = await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Ada' }) });
  assert.equal(result.status, 201);
  assert.equal(result.body.account.name, 'Ada');
  assert.equal(result.body.account.balance, 0);
  assert.ok(result.body.account.id);
  assert.ok(result.body.account.created_at);
});

test('rejects client-supplied initial balances', async () => {
  const result = await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Ada', balance: 999 }) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INITIAL_BALANCE_NOT_ALLOWED');
});

test('credits, debits, exposes balance, and preserves history', async () => {
  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Lin' }) })).body.account;
  let result = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 100, description: 'Deposit', reference_id: 'dep-1' }) });
  assert.equal(result.status, 201);
  assert.equal(result.body.balance, 100);
  result = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'debit', amount: 30, description: 'Lunch', reference_id: 'dbt-1' }) });
  assert.equal(result.status, 201);
  assert.equal(result.body.balance, 70);
  result = await request(`/accounts/${account.id}/balance`);
  assert.deepEqual(result.body, { account_id: account.id, balance: 70 });
  result = await request(`/accounts/${account.id}/transactions`);
  assert.equal(result.body.transactions.length, 2);
  assert.equal(result.body.transactions[0].type, 'debit');
  assert.deepEqual(result.body.pagination, { current_page: 1, page_size: 20, total_records: 2, total_pages: 1 });
});

test('filters and paginates latest-first transaction history', async () => {
  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Mina' }) })).body.account;
  for (const [type, amount, reference] of [['credit', 10, 'one'], ['debit', 2, 'two'], ['credit', 20, 'three']]) {
    const result = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type, amount, description: reference, reference_id: reference }) });
    assert.equal(result.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  let result = await request(`/accounts/${account.id}/transactions?type=credit&page=1&limit=1`);
  assert.equal(result.status, 200);
  assert.equal(result.body.transactions.length, 1);
  assert.equal(result.body.transactions[0].reference_id, 'three');
  assert.deepEqual(result.body.pagination, { current_page: 1, page_size: 1, total_records: 2, total_pages: 2 });
  result = await request(`/accounts/${account.id}/transactions?type=credit&page=2&limit=1`);
  assert.equal(result.body.transactions[0].reference_id, 'one');
  result = await request(`/accounts/${account.id}/transactions?type=refund`);
  assert.equal(result.status, 400);
});

test('rejects overdrafts and duplicate references without changing balance', async () => {
  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Grace' }) })).body.account;
  await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 50, description: 'Funding', reference_id: 'same' }) });
  let result = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'debit', amount: 60, description: 'Too much', reference_id: 'overdraft' }) });
  assert.equal(result.status, 422);
  result = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 1, description: 'Duplicate', reference_id: 'same' }) });
  assert.equal(result.status, 409);
  result = await request(`/accounts/${account.id}/balance`);
  assert.equal(result.body.balance, 50);
  result = await request(`/accounts/${account.id}/transactions`);
  assert.equal(result.body.transactions.length, 1);
});

test('validates invalid transaction payloads without changing state', async () => {
  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Validation' }) })).body.account;
  const invalidBodies = [
    { type: 'refund', amount: 1, description: 'Invalid type', reference_id: 'invalid-type' },
    { type: 'credit', amount: 0, description: 'Zero', reference_id: 'zero' },
    { type: 'credit', amount: -1, description: 'Negative', reference_id: 'negative' },
    { type: 'credit', amount: '10', description: 'String amount', reference_id: 'string' },
    { type: 'credit', amount: 1.001, description: 'Too precise', reference_id: 'precision' },
    { type: 'credit', description: 'Missing amount', reference_id: 'missing-amount' },
    { type: 'credit', amount: 1, reference_id: 'missing-description' },
    { type: 'credit', amount: 1, description: 'Missing reference' },
  ];
  for (const body of invalidBodies) {
    const result = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(result.status, 400);
  }
  const balance = await request(`/accounts/${account.id}/balance`);
  const history = await request(`/accounts/${account.id}/transactions`);
  assert.equal(balance.body.balance, 0);
  assert.equal(history.body.transactions.length, 0);
});

test('allows a reference ID to be reused by different accounts', async () => {
  const first = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'First' }) })).body.account;
  const second = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Second' }) })).body.account;
  for (const account of [first, second]) {
    const result = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 1, description: 'Shared reference', reference_id: 'shared' }) });
    assert.equal(result.status, 201);
  }
});

test('keeps decimal amount calculations exact to two decimal places', async () => {
  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Decimals' }) })).body.account;
  await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 0.1, description: 'Ten cents', reference_id: 'decimal-1' }) });
  await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 0.2, description: 'Twenty cents', reference_id: 'decimal-2' }) });
  const balance = await request(`/accounts/${account.id}/balance`);
  assert.equal(balance.body.balance, 0.3);
});

test('handles concurrent debit and duplicate-reference submissions safely', async () => {
  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Concurrent' }) })).body.account;
  await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 100, description: 'Funding', reference_id: 'funding' }) });
  const debitResults = await Promise.all(['a', 'b'].map((suffix) => request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'debit', amount: 80, description: `Debit ${suffix}`, reference_id: `debit-${suffix}` }) })));
  assert.equal(debitResults.filter((result) => result.status === 201).length, 1);
  assert.equal(debitResults.filter((result) => result.status === 422).length, 1);
  assert.equal((await request(`/accounts/${account.id}/balance`)).body.balance, 20);

  const duplicateResults = await Promise.all([1, 2].map(() => request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 5, description: 'Duplicate race', reference_id: 'race-reference' }) })));
  assert.equal(duplicateResults.filter((result) => result.status === 201).length, 1);
  assert.equal(duplicateResults.filter((result) => result.status === 409).length, 1);
  assert.equal((await request(`/accounts/${account.id}/balance`)).body.balance, 25);
});

test('does not expose mutable transaction routes', async () => {
  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Immutable' }) })).body.account;
  const created = await request(`/accounts/${account.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 10, description: 'Original', reference_id: 'immutable' }) });
  for (const method of ['PATCH', 'DELETE']) {
    const result = await request(`/accounts/${account.id}/transactions/${created.body.transaction.id}`, { method, body: JSON.stringify({ amount: 999 }) });
    assert.equal(result.status, 404);
  }
  const history = await request(`/accounts/${account.id}/transactions`);
  assert.equal(history.body.transactions[0].amount, 10);
  assert.equal(history.body.transactions[0].description, 'Original');
});

test('validates malformed data and unknown accounts consistently', async () => {
  let result = await request('/accounts', { method: 'POST', body: JSON.stringify(null) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_REQUEST_BODY');
  result = await request('/accounts', { method: 'POST', body: '{invalid-json' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_JSON');
  result = await request('/accounts/not-real/balance');
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'ACCOUNT_NOT_FOUND');
  result = await request('/accounts/not-real/transactions?limit=0');
  assert.equal(result.status, 404);
  result = await request('/accounts/not-real/transactions', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(result.status, 404);

  const account = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Pagination check' }) })).body.account;
  result = await request(`/accounts/${account.id}/transactions?page=zero`);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_PAGE');
});

test('transfers funds atomically between existing accounts', async () => {
  const source = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Source' }) })).body.account;
  const destination = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Destination' }) })).body.account;
  await request(`/accounts/${source.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 100, description: 'Seed', reference_id: 'seed' }) });
  let result = await request('/transfers', { method: 'POST', body: JSON.stringify({ source_account_id: source.id, destination_account_id: destination.id, amount: 30, description: 'Settlement', reference_id: 'tx-1' }) });
  assert.equal(result.status, 201);
  assert.equal(result.body.transfer.source_balance, 70);
  assert.equal(result.body.transfer.destination_balance, 30);
  const sourceHistory = await request(`/accounts/${source.id}/transactions`);
  const destinationHistory = await request(`/accounts/${destination.id}/transactions`);
  assert.equal(sourceHistory.body.transactions.length, 2);
  assert.equal(destinationHistory.body.transactions.length, 1);
  assert.equal(sourceHistory.body.transactions[0].type, 'debit');
  assert.equal(destinationHistory.body.transactions[0].type, 'credit');
  assert.equal(sourceHistory.body.transactions[0].reference_id, 'tx-1:debit');
  assert.equal(destinationHistory.body.transactions[0].reference_id, 'tx-1:credit');
  result = await request('/transfers', { method: 'POST', body: JSON.stringify({ source_account_id: source.id, destination_account_id: destination.id, amount: 80, description: 'Too much', reference_id: 'tx-2' }) });
  assert.equal(result.status, 422);
  assert.equal((await request(`/accounts/${source.id}/balance`)).body.balance, 70);
  assert.equal((await request(`/accounts/${destination.id}/balance`)).body.balance, 30);
});

test('rolls back a transfer if destination transaction insertion fails', async () => {
  const source = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Rollback source' }) })).body.account;
  const destination = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Rollback destination' }) })).body.account;
  await request(`/accounts/${source.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 100, description: 'Funding', reference_id: 'funding' }) });
  await request(`/accounts/${destination.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 1, description: 'Existing reference', reference_id: 'rollback:credit' }) });
  const result = await request('/transfers', { method: 'POST', body: JSON.stringify({ source_account_id: source.id, destination_account_id: destination.id, amount: 30, description: 'Must rollback', reference_id: 'rollback' }) });
  assert.equal(result.status, 409);
  assert.equal((await request(`/accounts/${source.id}/balance`)).body.balance, 100);
  assert.equal((await request(`/accounts/${destination.id}/balance`)).body.balance, 1);
  assert.equal((await request(`/accounts/${source.id}/transactions`)).body.transactions.length, 1);
  assert.equal((await request(`/accounts/${destination.id}/transactions`)).body.transactions.length, 1);
});

test('rejects invalid transfer account combinations without mutation', async () => {
  const source = (await request('/accounts', { method: 'POST', body: JSON.stringify({ name: 'Transfer validation' }) })).body.account;
  await request(`/accounts/${source.id}/transactions`, { method: 'POST', body: JSON.stringify({ type: 'credit', amount: 10, description: 'Funding', reference_id: 'funding' }) });
  let result = await request('/transfers', { method: 'POST', body: JSON.stringify({ source_account_id: source.id, destination_account_id: source.id, amount: 1, description: 'Same', reference_id: 'same' }) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'SAME_ACCOUNT_TRANSFER');
  result = await request('/transfers', { method: 'POST', body: JSON.stringify({ source_account_id: source.id, destination_account_id: 'not-real', amount: 1, description: 'Unknown', reference_id: 'unknown' }) });
  assert.equal(result.status, 404);
  assert.equal((await request(`/accounts/${source.id}/balance`)).body.balance, 10);
});
