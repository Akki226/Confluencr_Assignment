const http = require('node:http');
const { Ledger, LedgerError } = require('./ledger');

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new LedgerError(400, 'INVALID_JSON', 'request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

function createServer(ledger = new Ledger()) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok' });
      }
      if (request.method === 'POST' && url.pathname === '/accounts') {
        return sendJson(response, 201, { account: ledger.createAccount(await readJson(request)) });
      }
      if (request.method === 'POST' && url.pathname === '/transfers') {
        return sendJson(response, 201, { transfer: ledger.transfer(await readJson(request)) });
      }
      if (parts[0] === 'accounts' && parts.length >= 2) {
        const accountId = parts[1];
        if (request.method === 'GET' && parts.length === 2) {
          return sendJson(response, 200, { account: ledger.getAccount(accountId) });
        }
        if (request.method === 'GET' && parts.length === 3 && parts[2] === 'balance') {
          const account = ledger.getAccount(accountId);
          return sendJson(response, 200, { account_id: account.id, balance: account.balance });
        }
        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'transactions') {
          return sendJson(response, 201, ledger.addTransaction(accountId, await readJson(request)));
        }
        if (request.method === 'GET' && parts.length === 3 && parts[2] === 'transactions') {
          return sendJson(response, 200, ledger.getTransactions(accountId, {
            type: url.searchParams.get('type') ?? undefined,
            page: url.searchParams.get('page') ?? undefined,
            limit: url.searchParams.get('limit') ?? undefined,
          }));
        }
      }
      return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    } catch (error) {
      if (error instanceof LedgerError) {
        return sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      }
      return sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
    }
  });
}

module.exports = { createServer };
