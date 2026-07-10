export { TallyClient, TallyHttpError, type TallyClientOptions } from './tally-client.js';
export {
  createOperations,
  executeOperation,
  OperationError,
  type ExecuteResult,
} from './operations.js';
export { startSimulator, type SimulatorHandle, type SimulatorMode } from './simulator.js';
export { runConnector, CONNECTOR_VERSION } from './main.js';
export {
  buildCollectionRequest,
  requests,
  parseCompanies,
  parseLedgers,
  parseBills,
  toSearchPayload,
  toLedgerBalancePayload,
  tallyDateToIso,
  isoToTallyDate,
  TallyParseError,
  type ParsedLedger,
} from './xml.js';
