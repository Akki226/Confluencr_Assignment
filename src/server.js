const { createServer } = require('./app');
const { Ledger } = require('./ledger');

const port = Number(process.env.PORT) || 3000;
const databasePath = process.env.LEDGER_DB_PATH || 'ledger.sqlite';
createServer(new Ledger(databasePath)).listen(port, () => console.log(`Ledger API listening on port ${port}`));
