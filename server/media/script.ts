import type { FinanceMover, FinanceScript, MoverDirection } from "./types.ts";
import { assertFiniteNumber, isRecord, readString } from "./utils.ts";

const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

function normalizeSourceIds(value: unknown, index: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`movers[${index}].sourceIds must contain at least one source id.`);
  }
  const ids = value.map((item, sourceIndex) =>
    readString(item, `movers[${index}].sourceIds[${sourceIndex}]`, 1, 200),
  );
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeMover(value: unknown, index: number): FinanceMover {
  if (!isRecord(value)) throw new Error(`movers[${index}] must be an object.`);

  const ticker = readString(value.ticker, `movers[${index}].ticker`, 1, 10).toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) {
    throw new Error(`movers[${index}].ticker contains unsupported characters.`);
  }

  const direction = value.direction;
  if (direction !== "up" && direction !== "down") {
    throw new Error(`movers[${index}].direction must be up or down.`);
  }

  const changePct = assertFiniteNumber(value.changePct, `movers[${index}].changePct`);
  if (changePct === 0) throw new Error(`movers[${index}].changePct cannot be zero.`);
  const expectedDirection: MoverDirection = changePct > 0 ? "up" : "down";
  if (direction !== expectedDirection) {
    throw new Error(
      `movers[${index}] is contradictory: ${changePct}% implies direction ${expectedDirection}, not ${direction}.`,
    );
  }

  return {
    ticker,
    company: readString(value.company, `movers[${index}].company`, 1, 80),
    direction,
    changePct,
    catalyst: readString(value.catalyst, `movers[${index}].catalyst`, 1, 180),
    sourceIds: normalizeSourceIds(value.sourceIds, index),
  };
}

export function normalizeFinanceScript(value: unknown): FinanceScript {
  if (!isRecord(value)) throw new Error("script must be an object.");
  if (value.language !== "es") throw new Error("script.language must be es.");
  if (!Array.isArray(value.movers) || value.movers.length < 2 || value.movers.length > 4) {
    throw new Error("script.movers must contain between 2 and 4 movers.");
  }

  const movers = value.movers.map(normalizeMover);
  const tickers = new Set<string>();
  for (const mover of movers) {
    if (tickers.has(mover.ticker)) throw new Error(`Duplicate mover ticker: ${mover.ticker}.`);
    tickers.add(mover.ticker);
  }

  return {
    title: readString(value.title, "script.title", 1, 90),
    language: "es",
    narration: readString(value.narration, "script.narration", 120, 900),
    movers,
    closing: readString(value.closing, "script.closing", 1, 180),
  };
}
