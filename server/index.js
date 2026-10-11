'use strict';

const path = require('node:path');
const { createCentralService } = require('./central-service');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function integerOption(name, fallback, minimum, maximum) {
  const value = option(name, fallback);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} doit être un entier entre ${minimum} et ${maximum}.`);
  }
  return number;
}

async function start() {
  const dataDirectory = path.resolve(option(
    '--data-dir',
    process.env.LOTISSEMENT_SERVER_DATA || path.join(__dirname, 'data')
  ));
  const service = await createCentralService({
    dataDirectory,
    databasePath: option('--database', process.env.LOTISSEMENT_DATABASE),
    backupDirectory: option('--backups', process.env.LOTISSEMENT_BACKUPS),
    host: option('--host', process.env.LOTISSEMENT_HOST || '0.0.0.0'),
    port: integerOption('--port', process.env.LOTISSEMENT_PORT || 8765, 1, 65535)
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Arrêt du serveur (${signal}).`);
    await service.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  return service;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Impossible de démarrer le serveur central.', error);
    process.exitCode = 1;
  });
}

module.exports = { start };
