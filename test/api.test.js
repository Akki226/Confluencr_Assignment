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
});

test('validates malformed data and unknown accounts consistently', async () => {
  let result = await request('/accounts', { method: 'POST', body: JSON.stringify(null) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_REQUEST_BODY');
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
  result = await request('/transfers', { method: 'POST', body: JSON.stringify({ source_account_id: source.id, destination_account_id: destination.id, amount: 80, description: 'Too much', reference_id: 'tx-2' }) });
  assert.equal(result.status, 422);
  assert.equal((await request(`/accounts/${source.id}/balance`)).body.balance, 70);
  assert.equal((await request(`/accounts/${destination.id}/balance`)).body.balance, 30);
});
